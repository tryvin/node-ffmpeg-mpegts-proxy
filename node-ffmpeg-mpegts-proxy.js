/*
* Require libraries
*/
var yargs = require('yargs');
var winston = require('winston');
var http = require("http");
var child_process = require('child_process');
var sleep = require('sleep');
var executable = require('executable');
var avconv = require('./libs/avconv/avconv');

var options = require('./libs/options');
var commandExists = require('command-exists');


/*
* Read command line options
*/
var argv = yargs
.usage('Usage: $0 -p <port> -s <sources> [-a <avconv>] [-q | -v | -l]')
.alias('p', 'port')
.alias('l', 'listen')
.alias('a', 'avconv')
.alias('s', 'sources')
.alias('q', 'quiet')
.alias('v', 'verbose')
.demand(['p', 's'])
.default('a', 'avconv')
.default('l', '::')
.describe('p', 'The port the HTTP server should be listening on')
.describe('l', 'The address to listen on')
.describe('a', 'The path to avconv, defaults to just "avconv"')
.describe('s', 'The path to sources.json, defaults to "data/sources.json"')
.describe('q', 'Disable all logging to stdout')
.describe('v', 'Enable verbose logging (shows the output from avconv)')
.argv;

/*
* Configure logger
*/
winston.remove(winston.transports.Console);

if (!argv.quiet)
{
	winston.add(winston.transports.Console, {
		timestamp: true,
		colorize: true,
		level: argv.verbose ? 'silly' : 'debug'
	});
}

/**
* Check that the avconv is useable
*/
if (!argv.avconv) {
	argv.avconv = 'avconv';
}

commandExists(argv.avconv, function(err, exists) {
	if (!exists) {
		//Check if ffmpeg exists
		commandExists('ffmpeg', function(err, exists) {
			if ( ! exists ) {
				winston.error('neither avconv, nor ffmpeg found or is not executable');
				process.exit();
			}
			else {
				argv.avconv = 'ffmpeg';
			}
		});
	}
});

// Start the server

var ClusterServer = require('./libs/cluster')(argv);

ClusterServer.name = 'node-ffmpeg-mpegts-proxy';
ClusterServer.start(require('./libs/server')(argv), argv.port, argv.l);
