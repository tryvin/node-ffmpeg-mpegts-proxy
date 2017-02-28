var cluster = require('cluster');
var os  = require('os');
var winston = require('winston');

var sources = require('./sources');

module.exports = function(argv) {
    return {
    	name: 'ClusterServer',
    	count: (argv.verbose ? 1 : (2 * os.cpus().length)),
    	autoRestart: true,
        ffmpegWorker: false,
        ffmpegHandler: false,
        handleIncomingChildMessage: function(msg) {
            if ( msg.cmd == 'startStream' ) {
                this.ffmpegHandler.handleMessage(msg);
            }
            else if ( msg.cmd == 'stopStream' ) {
                this.ffmpegHandler.handleMessage(msg);
            }
        },
        handleIncomingFFMpegMessage: function(msg) {
            console.log(msg);
        },
    	start: function(server, port, l) {
    		var me = this, i;

            //Load sources
            sources.load(argv.sources,
                function() {
                    winston.info('Source definitions have changed, reloading ...');
                },
                function(error) {
                    winston.info(error);
                    winston.info('Unable to read source definitions: %s', error.toString());
                },
                function(numSources) {
                    winston.info('Loaded %d sources', numSources);
                }
            );

    		if ( cluster.isMaster ) {
                winston.info('Starting FFMpeg handler');
                this.ffmpegHandler = require('./ffmpeghandler')(argv, sources);

                winston.info("Forking ffmpeg instance");
                this.ffmpegWorker = cluster.fork();

                this.ffmpegWorker.on('message', function(message) {
                    me.handleIncomingFFMpegMessage(message);
                }).send({cmd: 'startFFMPEGServer'});

    			for ( i = 0; i < me.count; i++ ) {
    				winston.info("Forking new HTTP instance %d", i);

    				cluster.fork().on('message', function(message) {
    					me.handleIncomingChildMessage(message);
    				}).send({cmd: 'startHTTPServer'});
    			}

    			cluster.on('exit', function(worker) {
    				winston.error(me.name + ': worker '+ worker.id + ' died');

    				if ( me.autoRestart ) {
                        if ( worker.id == me.ffmpegWorker.id ) {
                            me.ffmpegWorker = cluster.fork();

                            me.ffmpegWorker.on('message', function(message) {
                                me.handleIncomingFFMpegMessage(message);
                            }).send({cmd: 'startFFMPEGServer'});
                        }
                        else {
                            cluster.fork().on('message', function(message) {
            					me.handleIncomingChildMessage(message);
            				}).send({cmd: 'startHTTPServer'});
                        }
    				}
    			});
    		}
    		else {
                process.on('message', function(msg) {
                    if ( msg.cmd == 'startFFMPEGServer' ) {
                        winston.info('[FFMPEG] Server listening for worker messages');
                    }
                    else if ( msg.cmd == 'startHTTPServer' ) {
                        server.listen(port, l);

                        winston.info('[HTTP] Server listening on port %d', port);
                    }
    			});
    		}
    	}
    };
}
