/*jshint node:true */
if (typeof process !== 'undefined' && typeof define === 'undefined') {
	(function () {
		var pathUtils = require('path');

		global.dojoConfig = {
			async: 1,
			baseUrl: pathUtils.resolve(__dirname, '..'),
			deps: [ 'teststack/runner' ],
			packages: [
				{ name: 'dojo-ts', location: pathUtils.resolve(__dirname, 'dojo') },
				{ name: 'teststack', location: __dirname }
			],
			tlmSiblingOfDojo: 0
		};

		require('./dojo/dojo');
	})();
}
else {
	define([
		'require',
		'./main',
		'./lib/createProxy',
		'dojo-ts/node!path',
		'dojo-ts/node!istanbul/lib/instrumenter',
		'dojo-ts/node!sauce-connect-launcher',
		'./lib/args',
		'./lib/util',
		'./lib/Suite',
		'./lib/ClientSuite',
		'./lib/Test',
		'./lib/wd',
		'dojo-ts/io-query',
		'dojo-ts/Deferred',
		'dojo-ts/topic',
		'./lib/EnvironmentType'
	], function (require, main, createProxy, pathUtils, Instrumenter, startConnect, args, util, Suite, ClientSuite, Test, wd, ioQuery, Deferred, topic, EnvironmentType) {
		if (!args.config) {
			throw new Error('Required option "config" not specified');
		}

		if (!args.reporter) {
			console.info('Defaulting to "runner" reporter');
			args.reporter = 'runner';
		}

		args.reporter = args.reporter.indexOf('/') > -1 ? args.reporter : './lib/reporters/' + args.reporter;

		require([ args.config, args.reporter ], function (config) {
			config.proxyUrl = config.proxyUrl.replace(/\/*$/, '/');

			createProxy(config.proxyPort, new Instrumenter({
				// coverage variable is changed primarily to avoid any jshint complaints, but also to make it clearer
				// where the global is coming from
				coverageVariable: '__teststackCoverage',

				// compacting code makes it harder to look at but it does not really matter
				noCompact: true,

				// auto-wrap breaks code
				noAutoWrap: true
			}), global.require.baseUrl);

			// Running just the proxy and aborting is useful mostly for debugging, but also lets you get code coverage
			// reporting on the client if you want
			if (args.proxyOnly) {
				return;
			}

			// TODO: Verify that upon using delete, it is not possible for the program to retrieve these environment
			// variables another way.
			if (process.env.SAUCE_USERNAME) {
				config.webdriver.username = process.env.SAUCE_USERNAME;
				if (!(delete process.env.SAUCE_USERNAME)) {
					throw new Error('Failed to clear sensitive environment variable SAUCE_USERNAME');
				}
			}
			if (process.env.SAUCE_ACCESS_KEY) {
				config.webdriver.accessKey = process.env.SAUCE_ACCESS_KEY;
				if (!(delete process.env.SAUCE_ACCESS_KEY)) {
					throw new Error('Failed to clear sensitive environment variable SAUCE_ACCESS_KEY');
				}
			}

			// TODO: Global require is needed because context require does not currently have config mechanics built
			// in.
			this.require(config.loader);

			var startup;
			if (config.useSauceConnect) {
				if (!config.webdriver.username || !config.webdriver.accessKey) {
					throw new Error('Missing Sauce username or access key. Disable Sauce Connect or provide this information.');
				}

				startup = util.adapt(startConnect);
			}
			else {
				startup = function () {
					return {
						then: function (callback) {
							callback();
						}
					};
				};
			}

			main.maxConcurrency = config.maxConcurrency || Infinity;

			if (process.env.TRAVIS_COMMIT) {
				config.capabilities.build = process.env.TRAVIS_COMMIT;
			}

			util.flattenEnvironments(config.capabilities, config.environments).forEach(function (environmentType) {
				var suite = new Suite({
					name: 'main',
					remote: wd.remote(config.webdriver, environmentType),
					publishAfterSetup: true,
					setup: function () {
						var remote = this.get('remote');
						return remote.init()
						.then(function getEnvironmentInfo(sessionId) {
							// wd incorrectly puts the session ID on a sessionID property
							remote.sessionId = sessionId;

							// the remote needs to know the proxy URL so it can munge filesystem paths passed to
							// `get`
							remote.proxyUrl = config.proxyUrl;
						})
						.sessionCapabilities()
						.then(function (capabilities) {
							remote.environmentType = new EnvironmentType(capabilities);
							topic.publish('/session/start', remote);
						});
					},

					teardown: function () {
						var remote = this.get('remote');
						return remote.quit().always(function () {
							topic.publish('/session/end', remote);
						});
					}
				});

				suite.tests.push(new ClientSuite({ parent: suite, config: config }));
				main.suites.push(suite);
			});

			startup({
				logger: function () {
					console.log.apply(console, arguments);
				},
				username: config.webdriver.username,
				accessKey: config.webdriver.accessKey,
				port: config.webdriver.port
			}).then(function () {
				require(config.functionalSuites, function () {
					var hasErrors = false;

					topic.subscribe('/error, /test/fail', function () {
						hasErrors = true;
					});

					topic.publish('/runner/start');
					main.run().always(function () {
						topic.publish('/runner/end');
						process.exit(hasErrors ? 1 : 0);
					});
				});
			}, function (error) {
				console.error(error);
				process.exit(1);
			});
		});
	});
}
