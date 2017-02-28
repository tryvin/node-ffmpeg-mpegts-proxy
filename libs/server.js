/*
* Require libraries
*/
var yargs = require('yargs');
var winston = require('winston');
var http = require("http");

var sleep = require('sleep');
var avconv = require('./avconv/avconv');
var sources = require('./sources');
var options = require('./options');
var commandExists = require('command-exists');
var cluster = require('cluster');
var os  = require('os');

/*
* Define some global constants
*/
var STREAMING_RESTART_DELAY_SECONDS = 0;
var MINIMUM_BYTES_RECEIVED_SUCCESS = 4096;

var handlingUrls = {};

module.exports = function(argv) {
    /**
    * The main HTTP server process
    * @type @exp;http@call;createServer
    */
    var server = http.createServer(function (request, response) {
    	var remoteAddress = request.connection.remoteAddress;
    	winston.debug('Got request for %s from %s', request.url, remoteAddress);

    	if ( request.url == "/playlist.m3u" ) {
    		response.writeHead(200, {'Content-Type': 'text/plain'});
    		response.write("#EXTM3U\n\n");

    		var sourceList = sources.getSources().sort(function(a, b) {
    			return (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0));
    		});

    		for ( var sourceId in sourceList ) {
    			var source = sourceList[sourceId];

    			var sourceGroup = "General TV";
    			if ( typeof(source.group) != 'undefined' )
    			sourceGroup = source.group;

    			response.write("#EXTINF:-1 group-title=\""+sourceGroup+"\","+source.name+"\n");
    			response.write("http://"+request.headers.host+source.url+"\n\n");
    		}

    		response.end();

    		return;
    	}
        else {
            var source = sources.getByUrl(request.url);
            if (source === null)
            {
                winston.error('Unknown source %s', request.url);

        		response.writeHead(404, {"Content-Type": "text/plain"});
        		response.write("404 Not Found\n");
        		response.end();

        		return;
            }
            else {
                var requestStarted = false;

                request.on('close', function () {
                    var id = handlingUrls[source.url].indexOf(request);
                    if ( id > -1 )
                        handlingUrls[source.url].splice(id, 1);

                    if ( handlingUrls[source.url].length == 0 ) {
                        process.send({
                            cmd: 'stopStream',
                            url: request.url,
                            id: cluster.worker.id
                        });
                    }
            	});

                if ( ! handlingUrls[source.url] )
                    handlingUrls[source.url] = [];

                handlingUrls[source.url].push(request);

                process.on('message', function(message) {
                    if ( message.cmd == 'streamData' && message.url == source.url ) {
                        if ( ! requestStarted ) {
            				response.writeHead(200, {
            					'Content-Type': 'video/mp2t'
            				});
            				requestStarted = true;
            			}

                        if ( message.data.type == 'Buffer' )
            			    response.write(Buffer.from(message.data.data));
                        else
                            response.write(message.data);
                    }
                }).send({
                    cmd: 'startStream',
                    url: request.url,
                    id: cluster.worker.id
                });

                return;
            }
        }
    });

    return server;
};
