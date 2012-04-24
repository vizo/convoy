/**
 * @module asset_packager
 * @copyright 2012 Charles Jolley
 * 
 * Generates a single asset from one or more source assets. Needs to be 
 * configured with:
 * 
 *    {
 *      // compilers for various languages. Should yield a single language
 *      // (javascript or CSS)
 *      compilers: {
 *        'js': JavaScriptCompiler,
 *        'coffee': CoffeeScriptCompiler
 *      },
 *      
 *      // inspects compiled asset to find additional dependencies, etc.
 *      analyizer: JavaScriptAnalyzer,
 *      
 *      // combines assets to merge them into a single asset.
 *      linker: CommonJSModuleLinker,
 *
 *      // minifies the merged asset.
 *      minifier: UglifyMinifier,
 *      
 *      // postprocesses the asset. usually adds a copyright statement
 *      postprocessors: [HeaderPostprocessor],
 *      
 *      // used to resolve paths.
 *      basedir: '.'
 *    }
 */

var PATH    = require('path');
var FS      = require('fs');
var ASYNC   = require('async');
var RESOLVE = require('resolve');
var UTILS   = require('./utils');

var _extend = UTILS.extend;

function _reset(asset) {
  asset._sourceAssets = {};
  asset._build = null;
}

//..............................
// PLUGINS
//

function JavaScriptCompiler(asset, context, done) {
  FS.readFile(asset.path, 'utf8', function(err, data) {
    if (err) return done(err);
    asset.body = data;
    done();
  });
}

// simple analyzer implements same algorithm as sprockets but using node require
function JavaScriptAnalyzer(asset, context, done) {
  var requires = asset.body.match(/^\s*\/\/=\s+require\s+.+\s*$/mg),
      deps = {};

  if (requires) {
    try {
      requires = requires.map(function(line) {
        var id = line.match(/^\s*\/\/=\s+require\s+(.+)\s*$/m)[1];
        var path = context.resolve(id, PATH.dirname(asset.path));
        return path;
      });
    } catch(e) {
      return done(e);
    }

    asset.dependencies = requires;

  }

  done();

}

// walks dependency tree. returns ordered array of assets.
function _expandDependencies(context, seen, expanded, deps, done) {
  ASYNC.forEachSeries(deps, function(asset, next) {
    if (seen.indexOf(asset)>=0) return next();
    seen.push(asset);

    if (asset.dependencies.length === 0) {
      expanded.push(asset);
      return next();
    }

    ASYNC.mapSeries(asset.dependencies, function(path, next) {
      context.getSourceAsset(path, next);
    }, function(err, assets) {
      _expandDependencies(context, seen, expanded, assets, function(err) {
        expanded.push(asset);
        next();
      });
    });

  }, function(err) {
    done(err, expanded);    
  });
}

function SimpleMergeLinker(asset, context, done) {
  _expandDependencies(context, [], [], asset.assets, function(err, expanded) {
    if (err) return done(err);
    asset.body = 
      expanded.map(function(asset) { return asset.body; }).join("\n");
    done();
  });
}


function UglifyMinifier(asset, context, done) {
  done(); 
}

//...............................
// PACKAGED ASSET
//

function AssetPackager(config) {
  if (config) _extend(this, config);
  this.basedir = PATH.resolve(this.basedir);
  _reset(this);
}

// default properties
_extend(AssetPackager.prototype, {
  basedir: '.',

  compilers: {
    '.js': JavaScriptCompiler
  },

  analyzer: JavaScriptAnalyzer,

  linker: SimpleMergeLinker,

  minify: false,

  minifier: null
});

/**
 * Returns the asset descriptor for a given source asset. `done()` will be 
 * called with the asset instance. The asset should contain the compiled body
 * as well as any additional information extracted from the analyzer.
 * 
 * @param  {String}   assetPath Path to the asset. Will be resolved
 * @param  {Function} done [description]
 * @return {[type]}        [description]
 */
AssetPackager.prototype.getSourceAsset = function(assetPath, done) {
  assetPath = PATH.resolve(this.basedir, assetPath);
  if (!this._sourceAssets[assetPath]) {
    var self = this;
    this._sourceAssets[assetPath] = UTILS.once(function(done) {
      var compiler = self.compilers[PATH.extname(assetPath)],
          analyzer = self.analyzer,
          err;

      if (!compiler) {
        err = new Error('No compiler for '+assetPath);
      } else if (!analyzer) {
        err = new Error('No analyzer for '+self.path);
      } 
      if (err) return done(err);

      var asset = {
        path: assetPath,
        dependencies: []
      };

      compiler(asset, self, function(err) {
        if (err) return done(err);
        analyzer(asset, self, function(err) {
          return done(err, asset);
        });
      });
    });
  }

  this._sourceAssets[assetPath](done);
};

/**
 * Attempts to map a moduleId to a physical path, relative to the named 
 * rootPath. This will respect the installed compiler extensions.
 * 
 * @param  {String} moduleId module ID to resolve
 * @param  {String} rootPath Optional. Root path to begin from.
 * @return {String}          Resolved path or null if illegal.
 */
AssetPackager.prototype.resolve = function(moduleId, basedir) {
  return RESOLVE.sync(moduleId, {
    extensions: Object.keys(this.compilers),
    basedir:    basedir || this.basedir
  });
};

/**
 * Attempts to reverse a normalized moduleId for the passed path, relative to
 * the named basedir. Yields a normalized module Id for later referencing.
 * 
 * @param  {String} path     path to file
 * @param  {String} basedir  Optional basedir
 * @return {String}          module Id
 */
AssetPackager.prototype.unresolve = function(path, basedir) {
  throw new Error('unresolve() not yet implemented');
};

/**
 * Invokes done with an asset object describing the fully constructed asset.
 * The `body` property will contain the body text.
 * 
 * @param  {Function} done Invoked when build is complete.
 * @return {void}
 */
AssetPackager.prototype.build = function(done) {
  if (!this._build) {
    var self = this;
    this._build = UTILS.once(function(done) {
      var main     = self.main,
          linker   = self.linker,
          minifier = self.minifier, 
          postprocessors = self.postprocessors,
          err;

      if (!main) {
        err = new Error('Main module not specified for ' + self.path);
      } else if (!linker) {
        err = new Error('Linker not found for ' + self.path);
      } else if (!minifier && self.minify) {
        err = new Error('Minifier not found for ' + self.path);
      }

      // normalize some params
      if ('string' === typeof main) main = [main];
      if (!postprocessors) postprocessors = [];

      ASYNC.waterfall([
        function(next) {
          ASYNC.map(main, function(path, next) {
            path = self.resolve(path, self.basedir); // can be a module
            return self.getSourceAsset(path, next);
          }, next);

        }, function(assets, next) {
          var asset = {
            path:   self.path,
            assets: assets
          };

          linker(asset, self, function(err) {
            next(err, asset);
          });

        }, function(asset, next) {
          if (self.minify) {
            minifier(asset, self, function(err) {
              next(err, asset);
            });
          } else {
            next(null, asset);
          }      
        }
      ], done);
    });
  }

  this._build(done);
};

/**
 * Writes the asset to disk. If no outputPath is passed uses the default path
 * provided.
 * 
 * @param  {String}   outputPath Optional. output path to write to.
 * @param  {Function} done       Optional. Invoked when complete.
 * @return {void}              
 */
AssetPackager.prototype.write = function(outputPath, done) {
  if (!done && 'function' === typeof outputPath) {
    done = outputPath;
    outputPath = null;
  }

  if (!outputPath) outputPath = this.path;
  outputPath = PATH.resolve(outputPath);

  this.build(function(err, asset) {
    if (err) return done(err);
    FS.writeFile(outputPath, asset.body, asset.encoding || 'utf8', done);
  });
};

/**
 * Invalidates any caches so that the next call to the packager will rebuild
 * from scratch.
 * 
 * @return {void}
 */
AssetPackager.prototype.invalidate = function() {
  _reset(this);
};

/**
 * Returns a new packaged asset instance with the given config. This is the 
 * preferred public API.
 * 
 * @param  {hash} config   Build config. Include at least a `main`
 * @return {AssetPackager} New packager instance.
 */
module.exports = exports = function(config) {
  return new AssetPackager(config);
};

exports.AssetPackager      = AssetPackager; // for testing only
exports.JavaScriptCompiler = JavaScriptCompiler;
exports.JavaScriptAnalyzer = JavaScriptAnalyzer;
exports.SimpleMergeLinker  = SimpleMergeLinker;