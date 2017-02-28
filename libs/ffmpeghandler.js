//Process stuff
var child_process = require('child_process');
var executable = require('executable');
var winston = require('winston');

//FFMPEG Stuff
var avconv = require('./avconv/avconv');

var options = require('./options');
var cluster = require('cluster');

var handlingUrls = {};

/**
* Runs the specified script with the specified parameters.
*
* @param scriptPath
* @param params
*/
var runPrePostScript = function(scriptPath, params) {
	try {
		if (executable.sync(scriptPath)) {
			child_process.spawnSync(scriptPath, params);
		} else {
			winston.error("The specified script is not executable");
		}
	}
	catch (e) {
		winston.error("The specified script doesn't exist");
	}
};

module.exports = function(argv, sources) {
    return {
        __getStream: function(source) {
            var __this = this;

            if (source.prescript)
            {
                winston.debug("Executing pre-script %s", source.prescript);
                runPrePostScript(source.prescript, [source.source, source.url, source.provider, source.name]);
            }

            // Define options for the child process
            var avconvOptions = options.getAvconvOptions(source);
            winston.silly("Options passed to avconv: " + avconvOptions);

            var streamingLoop = function() {
                // Add "http_proxy" to the avconv environment if it is defined
        		var environment = process.env;

        		if (source.http_proxy) {
        			environment.http_proxy = source.http_proxy;
        		}

                // Determine the avconv binary to use
        		var avconvBinary = argv.avconv;

                if (source.avconv) {
        			avconvBinary = source.avconv;
        		}

                handlingUrls[source.url]['stream'] = avconv(avconvOptions, avconvBinary, environment);

                var checkTimeout = 0;
                var restartStream = function() {
                    if ( handlingUrls[source.url] ) {
                        if ( handlingUrls[source.url]['stream'].lastDataTime > 0 ) {
                            if ( Date.now() - handlingUrls[source.url]['stream'].startDataTime > 2000 ) {
                                winston.info("[FFmpeg] No Feed for 2 seconds");

                                handlingUrls[source.url]['stream'].kill();
                                handlingUrls[source.url]['stream'].lastDataTime = 0;
                            }
                            else {
                                handlingUrls[source.url]['stream'].lastDataTime = Date.now();
                                handlingUrls[source.url]['stream'].checkTimeout = setTimeout(restartStream, 2000);
                            }
                        }
                        else {
                            winston.error("[FFmpeg] Source not found on check");
                            handlingUrls[source.url]['stream'].checkTimeout = 0;
                        }
                    }
                }

                handlingUrls[source.url]['stream'].on('message', function(message) {
                    winston.silly(message);
                });

                handlingUrls[source.url]['stream'].on('data', function(chunk) {
                    if ( handlingUrls[source.url] ) {
                        if ( handlingUrls[source.url]['clients'].length > 0 ) {

                            if ( ! handlingUrls[source.url]['stream'].checkTimeout ) {
                                handlingUrls[source.url]['stream'].lastDataTime = Date.now();
                                handlingUrls[source.url]['stream'].checkTimeout = setTimeout(restartStream, 2000);
                            }

                            for(const aId in handlingUrls[source.url]['clients'] ) {
                                const clientId = handlingUrls[source.url]['clients'][aId];

                                if ( cluster.workers[clientId] ) {
                                    cluster.workers[clientId].send(
                                        {
                                            'cmd': 'streamData',
                                            'url': source.url,
                                            'data': chunk
                                        }
                                    );
                                }
                                else {
                                    __this.stopStream(source.url, clientId);
                                }
                            }
                        }
                        else {
                            __this.stopStream(source.url, false);
                        }
                    }
                });

                handlingUrls[source.url]['stream'].on('error', function() {
                    if ( handlingUrls[source.url] ) {
                        handlingUrls[source.url]['stream'].kill();
                    }
                });

                handlingUrls[source.url]['stream'].on('exit', function() {
                    if ( handlingUrls[source.url] ) {
                        if ( handlingUrls[source.url]['stream'].shouldRestart ) {
                            winston.error('avconv exited with code %d, respawning', code);

                            streamingLoop();
                        }
                    }
                });
            }

            streamingLoop();
        },
        startStream: function (streamUrl, processId) {
            var source = sources.getByUrl(streamUrl);

            if ( typeof(handlingUrls[streamUrl]) == 'undefined' ) {
                handlingUrls[streamUrl] = {
                    'stream': null,
                    'clients': [processId]
                };

                this.__getStream(source);
            }
            else
                if ( handlingUrls[streamUrl]['clients'].indexOf(processId) < 0 )
                    handlingUrls[streamUrl]['clients'].push(processId);
        },
        stopStream: function(streamUrl, processId) {
            if ( typeof(handlingUrls[streamUrl]) != 'undefined' ) {
                var id = handlingUrls[streamUrl]['clients'].indexOf(processId);
                if ( id > -1 )
                    handlingUrls[streamUrl]['clients'].splice(id, 1);

                if ( handlingUrls[streamUrl]['clients'].length == 0 || processId == null ) {
                    handlingUrls[streamUrl]['stream'].shouldRestart = false;

                    handlingUrls[streamUrl]['stream'].kill();
                    delete handlingUrls[streamUrl];

                    if ( sources.getByUrl(streamUrl).postscript )
                    {
                        var source = sources.getByUrl(streamUrl);

                        winston.debug("Executing post-script %s", sources.postscript);
                        runPrePostScript(source.postscript, [source.source, source.url, source.provider, source.name]);
                    }
                }
            }
        },
        handleMessage: function(message) {
            if ( message.cmd == 'startStream' ) {
                this.startStream(message.url, message.id);
            }
            else if ( message.cmd == 'stopStream' ) {
                this.stopStream(message.url, message.id);
            }
        }
    };
}
