/* vim:set ts=2 sw=2 sts=2 expandtab */
/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Jetpack.
 *
 * The Initial Developer of the Original Code is Mozilla.
 * Portions created by the Initial Developer are Copyright (C) 2011
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *  Irakli Gozalishvili <gozala@mozilla.com> (Original Author)
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */
var EXPORTED_SYMBOLS = [ 'Loader' ];

!function(exports) {

"use strict";

const { classes: Cc, Constructor: CC, interfaces: Ci, utils: Cu,
        results: Cr, manager: Cm } = Components;
const systemPrincipal = CC('@mozilla.org/systemprincipal;1', 'nsIPrincipal')();
const scriptLoader = Cc['@mozilla.org/moz/jssubscript-loader;1'].
                     getService(Ci.mozIJSSubScriptLoader);

const Sandbox = {
  new: function (prototype, principal) {
    let sandbox = Object.create(Sandbox, {
      sandbox: {
        value: Cu.Sandbox(principal || Sandbox.principal, {
          sandboxPrototype: prototype || Sandbox.prototype,
          wantXrays: Sandbox.wantXrays
        })
      }
    });
    // There are few properties (dump, Iterator) that by default appear in
    // sandboxes shadowing properties provided by a prototype. To workaround
    // this we override all such properties by copying them directly to the
    // sandbox.
    Object.keys(prototype).forEach(function onEach(key) {
      if (sandbox.sandbox[key] !== prototype[key])
        sandbox.sandbox[key] = prototype[key]
    });
    return sandbox
  },
  evaluate: function evaluate(source, uri, lineNumber) {
    return Cu.evalInSandbox(
      source,
      this.sandbox,
      this.version,
      uri,
      lineNumber || this.lineNumber
    );
  },
  load: function load(uri) {
    scriptLoader.loadSubScript(uri, this.sandbox);
  },
  merge: function merge(properties) {
    Object.getOwnPropertyNames(properties).forEach(function(name) {
      Object.defineProperty(this.sandbox, name,
                            Object.getOwnPropertyDescriptor(properties, name));
    }, this);
  },
  principal: systemPrincipal,
  version: '1.8',
  lineNumber: 1,
  wantXrays: false,
  prototype: {}
};

const Module = {
  new: function(id, uri) {
    let module = Object.create(this);

    module.id = id;
    module.uri = uri;
    module.exports = {};

    return module;
  },
  // TODO: I'd like to remove this, it's not used adds complexity and does
  // not has much adoption in commonjs either.
  setExports: function setExports(exports) {
    this.exports = exports;
  }
};

const Loader = {
  new: function (options) {
    let loader = Object.create(Loader, {
      globals: { value: options.globals || {} },
      // Manifest generated by a linker, containing map of module url's mapped
      // to it's requirements.
      manifest: { value: options.manifest || {} },
      sandboxes: { value: {} },

      // Following property may be passed in (usually for mocking purposes) in
      // order to override default modules cache.
      modules: { value: options.modules || Object.create(Loader.modules) },
    });
    loader.require = this.require.bind(loader, options.loader);

    loader.modules['@packaging'] = Object.freeze({
      id: '@packaging',
      exports: JSON.parse(JSON.stringify(options))
    });
    loader.modules['@loader'] = Object.freeze({
      exports: Object.freeze({ Loader: Loader }),
      id: '@loader'
    });

    // Loading globals for special module and put them into loader globals.
    let globals = loader.require('api-utils/globals!');
    Object.getOwnPropertyNames(globals).forEach(function(name) {
      Object.defineProperty(loader.globals, name,
                            Object.getOwnPropertyDescriptor(globals, name));
    });
    // Freeze globals so that modules won't have a chance to mutate scope of
    // other modules.
    Object.freeze(globals);

    dump = globals.dump;
    return loader;
  },
  modules: {
    'chrome': Object.freeze({
      exports: Object.freeze({
        Cc: Cc,
        CC: CC,
        Ci: Ci,
        Cu: Cu,
        Cr: Cr,
        Cm: Cm,
        components: Components,
        messageManager: 'addMessageListener' in exports ? exports : null
      }),
      id: 'chrome'
    }),
    'self': function self(loader, requirer) {
      return loader.require('api-utils/self!').create(requirer.uri);
    },
  },
  load: function load(module) {
    let require = Loader.require.bind(this, module.uri);
    require.main = this.main;
    let sandbox = this.sandboxes[module.uri] = Sandbox.new(this.globals);
    sandbox.merge({
      require: require,
      module: module,
      exports: module.exports
    });

    sandbox.load(module.uri);

    // Workaround for bug 674195. Freezing objects from other sandboxes fail,
    // so we create descendant and freeze it instead.
    if (typeof(module.exports) === 'object') {
      module.exports = Object.prototype.isPrototypeOf(module.exports) ?
                Object.freeze(module.exports) :
                Object.freeze(Object.create(module.exports));
    }
  },
  require: function require(base, id) {
    let module, manifest = this.manifest[base], requirer = this.modules[base];

    if (!id)
      throw Error("you must provide a module name when calling require() from "
                  + (requirer && requirer.id), base, id);

    // If we have a manifest for requirer, then all it's requirements have been
    // registered by linker and we should have a `uri` to the required module.
    // If we don't have a `uri` then it's pseudo-module requirement similar
    // to `chome`, in which case we use `id` to identify it in the module cache.
    // TODO: Modify manifest builder so that pseudo module entries like `chorme`
    // do have `uri` property that matches it's key in the module cache. For
    // details see: Bug-697422.
    let requirement = manifest && manifest.requirements[id];
    let uri = requirement && (requirement.uri || this.modules[id] && id);

    if (!uri)
        throw Error("Module: " + requirer && requirer.id + ' located at ' +
                    base + " has no athority to load: " + id);

    if (uri in this.modules) {
      module = this.modules[uri];
    }
    else {
      module = this.modules[uri] = Module.new(id, uri);
      this.load(module);
      Object.freeze(module);
    }

    // TODO: Find a better way to implement `self`.
    // Maybe something like require('self!path/to/data')
    if (typeof(module) === 'function')
      module = module(this, requirer);

    return module.exports;
  },
  main: function main(id, uri) {
    try {
      let module = this.modules[uri] = Module.new(id, uri);
      this.load(module);
      let main = Object.freeze(module).exports;
      if (main.main)
        main.main();
    } catch (error) {
      Cu.reportError(error);
      if (this.globals.console) this.globals.console.exception(error);
      throw error;
    }
  },
  spawn: function spawn(id, uri) {
    let loader = this;
    let process = this.require('api-utils/process');
    process.spawn(id, uri)(function(addon) {
      // Listen to `require!` channel's input messages from the add-on process
      // and load modules being required.
      addon.channel('require!').input(function({ requirer: { uri }, id }) {
        try {
          Loader.require.call(loader, uri, id).initialize(addon.channel(id));
        } catch (error) {
          this.globals.console.exception(error);
        }
      });
    });
  },
  unload: function unload(reason, callback) {
    this.require('api-utils/unload').send(reason, callback);
  }
};
exports.Loader = Loader;

}(this);
