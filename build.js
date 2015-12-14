#!/usr/bin/env node

/* global Promise */
var exec = require('child_process').exec;
var fs = require('fs-extra');

var yargs;
try {
	yargs = require('yargs');
}
catch (error) {
	require('child_process').execSync('npm install');
	yargs = require('yargs');
}

var DOJO_VERSION = '1.10';
var DOCSET_PATH = 'build/Dojo.docset';
var CONTENTS_PATH = DOCSET_PATH + '/Contents';
var RESOURCE_PATH = CONTENTS_PATH + '/Resources';
var DOCUMENT_PATH = RESOURCE_PATH + '/Documents';

function clone(repo, options) {
	return run('git clone --recurse-submodules ' + repo, options).catch(function (error) {
		var message = error.message.split('\n')[1];
		if (!/already exists and is not an empty directory/.test(message)) {
			throw error;
		}
	});
}

function checkout(commit, options) {
	return run('git checkout ' + commit, options);
}

function clean(options) {
	return Promise.all([
		run('git clean -d -f', options),
		run('rm -rf build')
	]);
}

function copy(src, dest) {
	return new Promise(function (resolve, reject) {
		fs.copy(src, dest, { clobber: true }, resolver(resolve, reject));
	});
}

function empty(dir) {
	return new Promise(function (resolve, reject) {
		fs.emptyDir(dir, resolver(resolve, reject));
	});
}

function mkdir(dir) {
	return new Promise(function (resolve, reject) {
		fs.mkdirs(dir, resolver(resolve, reject));
	});
}

function pull(repo, remote, branch) {
	var command = 'git pull';
	if (remote) {
		command += ' ' + remote;
		if (branch) {
			command += ' ' + branch;
		}
	}
	return run(command, { cwd: repo });
}

function readJson(path) {
	return new Promise(function (resolve, reject) {
		fs.readJson(path, resolver(resolve, reject));
	});
}

function reset(commit, options) {
	return run('git reset --hard ' + commit, options);
}

function resolver(resolve, reject) {
	return function (error, data) {
		if (error) {
			reject(error);
		}
		else {
			resolve(data);
		}
	};
}

function rm(paths) {
	if (!Array.isArray(paths)) {
		paths = [ paths ];
	}
	return Promise.all(paths.map(function (path) {
		return new Promise(function (resolve, reject) {
			fs.remove(path, resolver(resolve, reject));
		});
	}));
}

function run(command, options) {
	return new Promise(function (resolve, reject) {
		exec(command, options, resolver(resolve, reject));
	});
}

function titleCase(string) {
	return string.charAt(0).toUpperCase() + string.slice(1);
}

var tasks = {
	clone: {
		description: 'Clone the required repositories',
		command: function () {
			console.log('Cloning repos...');
			var repos = [
				'dojo/dapi',
				'dojo/docs',
				'wkeese/js-doc-parse',
				'phiggins42/rstwiki'
			];
			return Promise.all(repos.map(function (repo) {
				return clone('https://github.com/' + repo, { args: '--recursive' });
			})).then(function () {
				return run('npm install', { cwd: 'dapi' });
			});
		}
	},

	checkout: {
		description: 'Checkout the proper versions of everything',
		command: function () {
			return tasks.clone.command().then(function () {
				console.log('Versioning repos...');
				var dojo = [
					'dojo',
					'dijit',
					'dojox',
					'util'
				];
				return Promise.all(
					dojo.map(function (package) {
						return checkout(DOJO_VERSION, { cwd: 'rstwiki/_static/' + package }).then(function () {
							return pull('rstwiki/_static/' + package);
						});
					}).concat([
						checkout(DOJO_VERSION, { cwd: 'docs' }).then(function () {
							return pull('docs');
						}),
						checkout('52b9226', { cwd: 'dapi' }),
						checkout('c07a478', { cwd: 'js-doc-parse' }),
						checkout('dfec967', { cwd: 'rstwiki' })
					])
				);
			});
		}
	},

	patch: {
		description: 'Apply patches',
		command: function () {
			function patch(repo) {
				var patchFile = '../' + repo + '.patch';
				// test if the patch has been applied
				return run(
					'patch -p1 -R --dry-run --quiet -f < ' + patchFile, { cwd: repo }
				).catch(function () {
					// the patch hasn't already been applied, so apply it
					return run('patch -p1 -N < ' + patchFile, { cwd: repo });
				});
			}

			return tasks.checkout.command().then(function () {
				console.log('Applying patches...');
				return Promise.all([
					patch('js-doc-parse'),
					patch('rstwiki'),
					patch('dapi')
				]);
			});
		}
	},

	compile: {
		description: 'Compile the docset',
			command: function () {
			return tasks.patch.command().then(function () {
				console.log('Compiling reference guide...');
				return empty(DOCUMENT_PATH).then(function () {
					// Compile reference-guide
					return mkdir('rstwiki/export/build').then(function () {
						return run('make data html', { cwd: 'rstwiki/export', stdio: 'inherit' });
					}).then(function () {
						return rm('rstwiki/export/build/' + DOJO_VERSION);
					}).then(function () {
						return run('mv -f html ' + DOJO_VERSION, { cwd: 'rstwiki/export/build' });
					});
				});
			}).then(function () {
				// Compile API docs
				console.log('Compiling API docs...');
				return run('./parse.sh config=config.js', { cwd: 'js-doc-parse' }).then(function () {
					return Promise.all([
						copy('js-doc-parse/details.json', 'dapi/public/data/' + DOJO_VERSION + '/details.json'),
						copy('js-doc-parse/tree.json', 'dapi/public/data/' + DOJO_VERSION + '/tree.json')
					]);
				}).then(function () {
					return run('node spider.js', { cwd: 'dapi' });
				});
			});
		}
	},

	copy: {
		description: 'Copy resources into the docset',
		command: function () {
			console.log('Copying files...');
			return Promise.all([
				copy('Info.plist', CONTENTS_PATH + '/Info.plist'),
				copy('dapi/staticoutput', DOCUMENT_PATH),
				copy('rstwiki/export/build/' + DOJO_VERSION, DOCUMENT_PATH + '/reference-guide/' + DOJO_VERSION),
				copy('rstwiki/_static/dojo', DOCUMENT_PATH + '/scripts/dojo'),
				copy('rstwiki/_static/dijit', DOCUMENT_PATH + '/scripts/dijit')
			]);
		}
	},

	index: {
		description: 'Generate the docset index',
		command: function () {
			console.log('Generating index...');
			var sqlite = require('sqlite3');
			var dbPath = RESOURCE_PATH + '/docSet.dsidx';

			return Promise.all([
				readJson('js-doc-parse/details.json'),
				rm(dbPath)
			]).then(function (results) {
				return new Promise(function (resolve, reject) {
					var db = new sqlite.Database(dbPath);
					var data = results[0];

					db.serialize(function () {
						db.run('CREATE TABLE searchIndex(id INTEGER PRIMARY KEY, name TEXT, type TEXT, path TEXT);');
						db.run('CREATE UNIQUE INDEX anchor ON searchIndex (name, type, path);');

						var insert = db.prepare(
							'INSERT OR IGNORE INTO searchIndex(name, type, path) VALUES (?, ?, ?);');

						db.parallelize(function () {
							Object.keys(data).forEach(function (name) {
								var module = data[name];
								var moduleName = module.location;
								var page = DOJO_VERSION + '/' + name + '.html';
								var anchorBase = DOJO_VERSION + moduleName;
								insert.run(moduleName, titleCase(module.type), page);

								function makeAnchor(key) {
									return (anchorBase + '_' + key).replace(/[.\/]/g, '_');
								}

								if (module.methods) {
									module.methods.forEach(function (method) {
										if (method.name === 'constructor') {
											return;
										}
										if (method.private) {
											return;
										}

										var name = moduleName + '/' + method.name;
										var anchor = makeAnchor(method.name);
										insert.run(name, 'Method', page + '#' + anchor);
									});
								}

								if (module.properties) {
									module.properties.forEach(function (property) {
										var name = moduleName + '/' + property.name;
										var anchor = makeAnchor(property.name);
										insert.run(name, 'Property', page + '#' + anchor);
									});
								}

								if (module.events) {
									module.events.forEach(function (event) {
										var name = moduleName + '/' + event.name;
										var anchor = makeAnchor(event.name);
										insert.run(name, 'Event', page + '#' + anchor);
									});
								}
							});

							insert.finalize();
						});
					});

					db.close(resolver(resolve, reject));
				});
			});
		}
	},

	build: {
		description: 'Build the docset (compile it and generate the index)',
		command: function () {
			return tasks.compile.command().then(function () {
				return Promise.all([
					tasks.copy.command(),
					tasks.index.command()
				]);
			});
		}
	},

	clean: {
		description: 'Cleanup all build files',
		command: function () {
			console.log('Cleaning...');
			return empty('rstwiki/export').then(function () {
				return Promise.all([
					empty(DOCSET_PATH),
					rm('dapi/public/data/1.10'),
					clean({ cwd: 'rstwiki' }),
					clean({ cwd: 'dapi' }),
					clean({ cwd: 'js-doc-parse' }),
					reset('HEAD', { args: '--hard', cwd: 'rstwiki' }),
					reset('HEAD', { args: '--hard', cwd: 'dapi' }),
					reset('HEAD', { args: '--hard', cwd: 'js-doc-parse' })
				]);
			});
		}
	},

	package: {
		description: 'Package the docset',
		command: function () {
			console.log('Packaging...');
			return run('tar zcf Dojo-' + DOJO_VERSION + '.tgz Dojo.docset', { cwd: 'build' });
		}
	}
};

var start = Number(new Date());

var args = yargs
	.usage('usage: $0 COMMAND')
	.demand(1);

Object.keys(tasks).forEach(function (task) {
	args = args.command(task, tasks[task].description, function () {
		tasks[task].command().then(
			function () {
				var now = Number(new Date());
				var elapsed = now - start;
				console.log('Finished in ' + Math.round(elapsed / 1000) + ' seconds');
			},
			function (error) {
				var message = String(error);
				if (error.stack) {
					message += '\n' + error.stack.split('\n').slice(1).join('\n');
				}
				console.error(message);
			}
		);
	});
});

args = args.argv;
