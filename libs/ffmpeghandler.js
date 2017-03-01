//Process stuff
var child_process = require('child_process');
var executable = require('executable');
var winston = require('winston');

//FFMPEG Stuff
var avconv = require('./avconv/avconv');

var options = require('./options');
var cluster = require('cluster');

var rp = require('request-promise');

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

            //Function to start the stream from a URL
            var startStreamFromUrl = function(sourceUrl, source, noSignal) {
                var noSignal = noSignal || false;

                // Define options for the child process
                source.sourceFoundUrl = sourceUrl;

                var streamingLoop = function(noSignalForLoop) {
                    if ( ! noSignalForLoop )
                        var avconvOptions = options.getAvconvOptions(source);
                    else
                        var avconvOptions = options.getAvNoSignalOptions();

                    winston.silly("Options passed to avconv: " + avconvOptions);

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

                    if ( handlingUrls[source.url] ) {
                        handlingUrls[source.url]['stream'] = avconv(avconvOptions, avconvBinary, environment);

                        var checkTimeout = 0;
                        var restartStream = function() {
                            if ( handlingUrls[source.url] ) {
                                if ( handlingUrls[source.url]['stream'] ) {
                                    if ( ! noSignalForLoop ) {
                                        if ( handlingUrls[source.url]['stream'].lastDataTime > 0 ) {
                                            if ( Date.now() - handlingUrls[source.url]['stream'].startDataTime > 2000 ) {
                                                winston.info("[FFmpeg] No Feed for 2 seconds");

                                                handlingUrls[source.url]['stream'].kill();
                                                handlingUrls[source.url]['stream'].lastDataTime = 0;
                                            }
                                            else {
                                                handlingUrls[source.url]['stream'].lastDataTime = Date.now();
                                                handlingUrls[source.url]['streamCheckTimeout'] = setTimeout(restartStream, 2000);
                                            }
                                        }
                                    }
                                    else {
                                        checkUrl(0, urlList, function(sourceUrl, source, noSignalForCheck) {
                                            if ( handlingUrls[source.url] ) {
                                                if ( noSignalForCheck ) {
                                                    if ( handlingUrls[source.url]['streamCheckTimeout'] )
                                                        clearTimeout(handlingUrls[source.url]['streamCheckTimeout']);

                                                    handlingUrls[source.url]['streamCheckTimeout'] = setTimeout(restartStream, 20000);
                                                }
                                                else {
                                                    if ( handlingUrls[source.url]['streamCheckTimeout'] )
                                                        clearTimeout(handlingUrls[source.url]['streamCheckTimeout']);

                                                    handlingUrls[source.url]['stream'].shouldRestart = false;
                                                    handlingUrls[source.url]['stream'].kill();

                                                    handlingUrls[source.url]['streamExitNumber'] = 0;

                                                    source.sourceFoundUrl = sourceUrl;
                                                    streamingLoop();
                                                }
                                            }
                                        });
                                    }
                                }
                                else {
                                    winston.info("[FFMPEG] No source found");
                                }
                            }
                        }

                        handlingUrls[source.url]['stream'].on('message', function(message) {
                            winston.silly(message);
                        });

                        handlingUrls[source.url]['stream'].on('data', function(chunk) {
                            if ( handlingUrls[source.url] ) {
                                if ( handlingUrls[source.url]['clients'].length > 0 ) {

                                    if ( ! noSignalForLoop ) {
                                        handlingUrls[source.url]['streamExitNumber'] = 0;

                                        if ( ! handlingUrls[source.url]['streamCheckTimeout'] ) {
                                            handlingUrls[source.url]['stream'].lastDataTime = Date.now();
                                            handlingUrls[source.url]['streamCheckTimeout'] = setTimeout(restartStream, 2000);
                                        }
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

                        if ( noSignalForLoop ) {
                            if ( handlingUrls[source.url]['streamCheckTimeout'] )
                                clearTimeout(handlingUrls[source.url]['streamCheckTimeout']);

                            restartStream();
                        }

                        handlingUrls[source.url]['stream'].on('error', function() {
                            if ( handlingUrls[source.url] ) {
                                handlingUrls[source.url]['stream'].kill();
                            }
                        });

                        handlingUrls[source.url]['stream'].on('exit', function(code) {
                            if ( handlingUrls[source.url] ) {
                                if ( handlingUrls[source.url]['stream'] ) {
                                    if ( handlingUrls[source.url]['stream'].shouldRestart ) {
                                        winston.error('avconv exited with code %s, respawning', code);

                                        if ( handlingUrls[source.url]['streamExitNumber'] > 4 ) {
                                            handlingUrls[source.url]['streamExitNumber'] = 0;

                                            if ( handlingUrls[source.url]['streamCheckTimeout'] )
                                                clearTimeout(handlingUrls[source.url]['streamCheckTimeout']);

                                            streamingLoop(true);
                                        }
                                        else {
                                            handlingUrls[source.url]['streamExitNumber']++;
                                            streamingLoop();
                                        }
                                    }
                                }
                            }
                        });
                    }
                }

                streamingLoop(noSignal);
            }

            //First, check HTTP URLs
            var urlList = typeof(source.source) == 'string' ? [source.source] : source.source;
            var noHttpURLS = true;
            var hasNoHttpURL = false;

            var checkUrl = function(urlId, urlList, successCallback) {
                var successCallback = successCallback || false;

                if ( urlList[urlId].indexOf("http://") > -1 || urlList[urlId].indexOf("https://") > -1 ) {
                    noHttpURLS = false;

                    winston.info('[FFMPEG] Checking URL for ' + source.url + '('+urlList[urlId]+')');

                    rp({
                        method: "HEAD",
                        //I use 5 seconds as I guess it's a OK timeout for most IPtv servers
                        timeout: 5000,
                        uri: urlList[urlId],
                        resolveWithFullResponse: true
                    }).then(function(response) {
                        if ( response.statusCode == 200 ) {
                            /**
                            * We try our best to discover if this is a good stream based on HEAD,
                            *   if we fail here, ffmpeg should give us a hint later
                            *   Also, we should ignore text/html, playlists usually don't use text/html
                            */

                            if (
                                response.headers['content-type'].indexOf('video/')  > -1
                                ||
                                (
                                    response.headers['content-type'].indexOf('text/html') == -1 &&
                                    response.headers['content-length'] > 0
                                )
                            ) {
                                //This should be an active URL, if not, FFMPEG will tell us later
                                if ( ! successCallback )
                                    startStreamFromUrl(urlList[urlId], source);
                                else
                                    successCallback(urlList[urlId], source);
                            }
                            else {
                                if ( urlList.length > urlId + 1 )
                                    checkUrl(urlId + 1, urlList, successCallback);
                                else {
                                    if ( ! successCallback )
                                        startStreamFromUrl(urlList[urlId], source, true);
                                    else
                                        successCallback(urlList[urlId], source, true);
                                }
                            }
                        }
                        else if ( response.statusCode == 301 || response.statusCode == 302 ) {
                            //Well, the server answered, I guess it's ok

                            if ( ! successCallback )
                                startStreamFromUrl(urlList[urlId], source);
                            else
                                successCallback(urlList[urlId], source);
                        }
                        else {
                            if ( urlList.length > urlId + 1 )
                                checkUrl(urlId + 1, urlList, successCallback);
                            else {
                                if ( ! successCallback )
                                    startStreamFromUrl(urlList[urlId], source, true);
                                else
                                    successCallback(urlList[urlId], source, true);
                            }
                        }
                    }).catch(function(error) {
                        //Akamai doesn't like HEAD, so they return 405, we assume it's ok to go
                        if ( error.statusCode == 405 ) {
                            if ( ! successCallback )
                                startStreamFromUrl(urlList[urlId], source);
                            else
                                successCallback(urlList[urlId], source);
                        }
                        else {
                            if ( urlList.length > urlId + 1 )
                                checkUrl(urlId + 1, urlList, successCallback);
                            else {
                                if ( ! successCallback )
                                    startStreamFromUrl(urlList[urlId], source, true);
                                else
                                    successCallback(urlList[urlId], source, true);
                            }
                        }
                    });
                }
                else {
                    //TODO: Use someother library for RTMP for example
                    hasNoHttpURL = true;
                }
            }

            checkUrl(0, urlList);
        },
        startStream: function (streamUrl, processId) {
            var source = sources.getByUrl(streamUrl);

            if ( typeof(handlingUrls[streamUrl]) == 'undefined' ) {
                winston.info('[FFMpeg] Starting stream for ' + streamUrl);
                handlingUrls[streamUrl] = {
                    'stream': null,
                    'streamExitNumber': 0,
                    'streamCheckTimeout': 0,
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
                    if ( handlingUrls[streamUrl]['stream'] ) {
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
