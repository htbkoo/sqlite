/*
  2022-05-22

  The author disclaims copyright to this source code.  In place of a
  legal notice, here is a blessing:

  *   May you do good and not evil.
  *   May you find forgiveness for yourself and forgive others.
  *   May you share freely, never taking more than you give.

  ***********************************************************************

  This file is intended to be loaded after loading sqlite3.wasm. It
  sets one of any number of potential bindings using that API, this
  one as closely matching the C-native API as is feasible.

  Note that this file is not named sqlite3.js because that file gets
  generated by emscripten as the JS-glue counterpart of sqlite3.wasm.

  The API gets installed as self.sqlite3, where self is expected to be
  either the global window or Worker object. In addition, a higher-level
  OO API is installed as self.SQLite3.

  Potential TODO: instead of exporting 2 symbols, export only SQLite3
  as {api: sqlite3, oo1: SQLite3}. The way we export this module is
  not _really_ modern-JS-friendly because it exports global symbols
  (which is admittedly poor form). Exporting it "cleanly" requires
  using a module loader in all client code. As there are several
  different approaches, none of which this developer is currently
  truly familiar with, the current approach will have to do for the
  time being.

  Because using the low-level API properly requires some degree of
  WASM-related magic, it is not recommended that that API be used
  as-is in client-level code. Rather, client code should use the
  higher-level OO API or write such a wrapper on top of the
  lower-level API.

  This file installs namespace.sqlite3, where namespace is `self`,
  meaning either the global window or worker, depending on where this
  is loaded from.
*/
(function(namespace){
    /* For reference: sql.js does essentially everything we want and
       it solves much of the wasm-related voodoo, but we'll need a
       different structure because we want the db connection to run in
       a worker thread and feed data back into the main
       thread. Regardless of those differences, it makes a great point
       of reference:

       https://github.com/sql-js/sql.js

       Some of the specific design goals here:

       - Bind a low-level sqlite3 API which is close to the native one
         in terms of usage.

       - Create a higher-level one, more akin to sql.js and
         node.js-style implementations. This one would speak directly
         to the low-level API. This API could be used by clients who
         import the low-level API directly into their main thread
         (which we don't want to recommend but also don't want to
         outright forbid).

       - Create a second higher-level one which speaks to the
         low-level API via worker messages. This one would be intended
         for use in the main thread, talking to the low-level UI via
         worker messages. Because workers have only a single message
         channel, some acrobatics will be needed here to feed async
         work results back into client-side callbacks (as those
         callbacks cannot simply be passed to the worker). Exactly
         what those acrobatics should look like is not yet entirely
         clear and much experimentation is pending.
    */

    /** 
      Set up the main sqlite3 binding API here, mimicking the C API as
      closely as we can.

      Attribution: though not a direct copy/paste, much of what
      follows is strongly influenced by the sql.js implementation.
    */
    const api = {
        /* It is important that the following integer values match
           those from the C code. Ideally we could fetch them from the
           C API, e.g., in the form of a JSON object, but getting that
           JSON string constructed within our current confines is
           currently not worth the effort.

           Reminder to self: we could probably do so by adding the
           proverbial level of indirection, calling in to C to get it,
           and having that C func call an
           emscripten-installed/JS-implemented library function which
           builds the result object:

           const obj = {};
           sqlite3__get_enum(function(key,val){
               obj[key] = val;
           });

           but whether or not we can pass a function that way, via a
           (void*) is as yet unknown.
        */
        /* Minimum subset of sqlite result codes we'll need. */
        SQLITE_OK: 0,
        SQLITE_ROW: 100,
        SQLITE_DONE: 101,
        /* sqlite data types */
        SQLITE_INTEGER: 1,
        SQLITE_FLOAT: 2,
        SQLITE_TEXT: 3,
        SQLITE_BLOB: 4,
        SQLITE_NULL: 5,
        /* sqlite encodings, used for creating UDFs, noting that we
           will only support UTF8. */
        SQLITE_UTF8: 1
    };
    const cwrap = Module.cwrap;
    [/* C-side functions to bind. Each entry is an array with 3 or 4
        elements:
        
        ["c-side name",
         "result type" (cwrap() syntax),
         [arg types in cwrap() syntax]
        ]

        If it has 4 elements, the first one is an alternate name to
        use for the JS-side binding. That's required when overloading
        a binding for two different uses.
     */
        ["sqlite3_bind_blob","number",["number", "number", "number", "number", "number"]],
        ["sqlite3_bind_double","number",["number", "number", "number"]],
        ["sqlite3_bind_int","number",["number", "number", "number"]],
        ["sqlite3_bind_int64","number",["number", "number", "number"]],
        ["sqlite3_bind_null","void",["number"]],
        ["sqlite3_bind_parameter_count", "number", ["number"]],
        ["sqlite3_bind_parameter_index","number",["number", "string"]],
        ["sqlite3_bind_text","number",["number", "number", "number", "number", "number"]],
        ["sqlite3_changes", "number", ["number"]],
        ["sqlite3_clear_bindings","number",["number"]],
        ["sqlite3_close_v2", "number", ["number"]],
        ["sqlite3_column_blob","number", ["number", "number"]],
        ["sqlite3_column_bytes","number",["number", "number"]],
        ["sqlite3_column_count", "number", ["number"]],
        ["sqlite3_column_count","number",["number"]],
        ["sqlite3_column_double","number",["number", "number"]],
        ["sqlite3_column_name","string",["number", "number"]],
        ["sqlite3_column_text","string",["number", "number"]],
        ["sqlite3_column_type","number",["number", "number"]],
        ["sqlite3_compileoption_get", "string", ["number"]],
        ["sqlite3_compileoption_used", "number", ["string"]],
        ["sqlite3_create_function_v2", "number",
         ["number", "string", "number", "number","number",
          "number", "number", "number", "number"]],
        ["sqlite3_data_count", "number", ["number"]],
        ["sqlite3_db_filename", "string", ["number", "string"]],
        ["sqlite3_errmsg", "string", ["number"]],
        ["sqlite3_exec", "number", ["number", "string", "number", "number", "number"]],
        ["sqlite3_finalize", "number", ["number"]],
        ["sqlite3_interrupt", "void", ["number"]],
        ["sqlite3_libversion", "string", []],
        ["sqlite3_open", "number", ["string", "number"]],
        ["sqlite3_prepare_v2", "number", ["number", "string", "number", "number", "number"]],
        ["sqlite3_prepare_v2_sqlptr", "sqlite3_prepare_v2",
         /* Impl which requires that the 2nd argument be a pointer to
            the SQL, instead of a string. This is used for cases where
            we require a non-NULL value for the final argument. We may
            or may not need this, depending on how our higher-level
            API shapes up, but this code's spiritual guide (sql.js)
            uses it we we'll include it. */
         "number", ["number", "number", "number", "number", "number"]],
        ["sqlite3_reset", "number", ["number"]],
        ["sqlite3_result_blob",null,["number", "number", "number", "number"]],
        ["sqlite3_result_double",null,["number", "number"]],
        ["sqlite3_result_error",null,["number", "string", "number"]],
        ["sqlite3_result_int",null,["number", "number"]],
        ["sqlite3_result_null",null,["number"]],
        ["sqlite3_result_text",null,["number", "string", "number", "number"]],
        ["sqlite3_sourceid", "string", []],
        ["sqlite3_step", "number", ["number"]],
        ["sqlite3_value_blob", "number", ["number"]],
        ["sqlite3_value_bytes","number",["number"]],
        ["sqlite3_value_double","number",["number"]],
        ["sqlite3_value_text", "string", ["number"]],
        ["sqlite3_value_type", "number", ["number"]]
        //["sqlite3_sql", "string", ["number"]],
        //["sqlite3_normalized_sql", "string", ["number"]]
    ].forEach(function(a){
        const k = (4==a.length) ? a.shift() : a[0];
        api[k] = cwrap.apply(this, a);
    });
    //console.debug("libversion =",api.sqlite3_libversion());

    /* What follows is colloquially known as "OO API #1". It is a
       binding of the sqlite3 API which is designed to be run within
       the same thread (main or worker) as the one in which the
       sqlite3 WASM binding was initialized.  This wrapper cannot use
       the sqlite3 binding if, e.g., the wrapper is in the main thread
       and the sqlite3 API is in a worker. */
    /* memory for use in some pointer-passing routines */
    const pPtrArg = stackAlloc(4);
    const toss = function(){
        throw new Error(Array.prototype.join.call(arguments, ' '));
    };

    const sqlite3/*canonical name*/ = S/*convenience alias*/ = api;
    
    /**
       The DB class wraps a sqlite3 db handle.
    */
    const DB = function(name/*TODO: openMode flags*/){
        if(!name) name = ':memory:';
        else if('string'!==typeof name){
            toss("TODO: support blob image of db here.");
        }
        this.checkRc(S.sqlite3_open(name, pPtrArg));
        this.pDb = getValue(pPtrArg, "i32");
        this.filename = name;
        this._statements = {/*map of open Stmt _pointers_*/};
    };

    /**
       Internal-use enum for mapping JS types to DB-bindable types.
       These do not (and need not) line up with the SQLITE_type
       values. All values in this enum must be truthy and distinct
       but they need not be numbers.
    */
    const BindTypes = {
        null: 1,
        number: 2,
        string: 3,
        boolean: 4,
        blob: 5
    };
    BindTypes['undefined'] == BindTypes.null;

    /**
       This class wraps sqlite3_stmt. Calling this constructor
       directly will trigger an exception. Use DB.prepare() to create
       new instances.
    */
    const Stmt = function(){
        if(BindTypes!=arguments[2]){
            toss("Do not call the Stmt constructor directly. Use DB.prepare().");
        }
        this.db = arguments[0];
        this.pStmt = arguments[1];
        this.columnCount = S.sqlite3_column_count(this.pStmt);
        this.parameterCount = S.sqlite3_bind_parameter_count(this.pStmt);
        this._allocs = [/*list of alloc'd memory blocks for bind() values*/]
    };

    /** Throws if the given DB has been closed, else it is returned. */
    const affirmDbOpen = function(db){
        if(!db.pDb) toss("DB has been closed.");
        return db;
    };

    DB.prototype = {
        /**
           Expects to be given an sqlite3 API result code. If it is
           falsy, this function returns this object, else it throws an
           exception with an error message from sqlite3_errmsg(),
           using this object's db handle.
        */
        checkRc: function(sqliteResultCode){
            if(!sqliteResultCode) return this;
            toss(S.sqlite3_errmsg(this.pDb) || "Unknown db error.");
        },
        /**
           Finalizes all open statements and closes this database
           connection. This is a no-op if the db has already been
           closed.
        */
        close: function(){
            if(this.pDb){
                let s;
                const that = this;
                Object.keys(this._statements).forEach(function(k,s){
                    delete that._statements[k];
                    if(s && s.pStmt) s.finalize();
                });
                S.sqlite3_close_v2(this.pDb);
                delete this.pDb;
            }
        },
        /**
           Similar to this.filename but will return NULL for
           special names like ":memory:". Not of much use until
           we have filesystem support. Throws if the DB has
           been closed. If passed an argument it then it will return
           the filename of the ATTACHEd db with that name, else it assumes
           a name of `main`.
        */
        fileName: function(dbName){
            return S.sqlite3_db_filename(affirmDbOpen(this).pDb, dbName||"main");
        },
        /**
           Compiles the given SQL and returns a prepared Stmt. This is
           the only way to create new Stmt objects. Throws on error.
        */
        prepare: function(sql){
            affirmDbOpen(this);
            setValue(pPtrArg,0,"i32");
            this.checkRc(S.sqlite3_prepare_v2(this.pDb, sql, -1, pPtrArg, null));
            const pStmt = getValue(pPtrArg, "i32");
            if(!pStmt) toss("Empty SQL is not permitted.");
            const stmt = new Stmt(this, pStmt, BindTypes);
            this._statements[pStmt] = stmt;
            return stmt;
        }
    };

    /** Returns an opaque truthy value from the BindTypes
        enum if v's type is a valid bindable type, else
        returns a falsy value. */
    const isSupportedBindType = function(v){
        let t = BindTypes[null===v ? 'null' : typeof v];
        if(t) return t;
        // TODO: handle buffer/blob types.
        return undefined;
    }

    /**
       If isSupportedBindType(v) returns a truthy value, this
       function returns that value, else it throws.
    */
    const affirmSupportedBindType = function(v){
        const t = isSupportedBindType(v);
        if(t) return t;
        toss("Unsupport bind() argument type.");
    };

    /**
       If key is a number and within range of stmt's bound parameter
       count, key is returned.

       If key is not a number then it is checked against named
       parameters. If a match is found, its index is returned.

       Else it throws.
    */
    const indexOfParam = function(stmt,key){
        const n = ('number'===typeof key)
              ? key : S.sqlite3_bind_parameter_index(stmt.pStmt, key);
        if(0===n || (n===key && (n!==(n|0)/*floating point*/))){
            toss("Invalid bind() parameter name: "+key);
        }
        else if(n<1 || n>=stmt.parameterCount) toss("Bind index",key,"is out of range.");
        return n;
    };

    /**
       Binds a single bound parameter value on the given stmt at the
       given index (numeric or named) using the given bindType (see
       the BindTypes enum) and value. Throws on error. Returns stmt on
       success.
    */
    const bindOne = function(stmt,ndx,bindType,val){
        affirmSupportedBindType(val);
        ndx = indexOfParam(stmt,ndx);
        let rc = 0;
        switch(bindType){
            case BindType.null:
                rc = S.sqlite3_bind_null(stmt.pStmt, ndx);
                break;
            case BindType.string:{
                const bytes = intArrayFromString(string,false);
                const pStr = allocate(bytes, ALLOC_NORMAL);
                stmt._allocs.push(pStr);
                rc = S.sqlite3_bind_text(stmt.pStmt, ndx, pStr,
                                         bytes.length, 0);
                break;
            }
            case BindType.number: {
                const m = ((val === (val|0))
                           ? (val>0xefffffff
                              ? S.sqlite3_bind_int64
                              : S.sqlite3_bind_int)
                           : S.sqlite3_bind_double);
                rc = m(stmt.pStmt, ndx, val);
                break;
            }
            case BindType.boolean:
                rc = S.sqlite3_bind_int(stmt.pStmt, ndx, val ? 1 : 0);
                break;
            case BindType.blob:
            default: toss("Unsupported bind() argument type.");
        }
        if(rc) stmt.db.checkRc(rc);
        return stmt;
    };

    /** Throws if the given Stmt has been finalized, else
        it is returned. */
    const affirmStmtOpen = function(stmt){
        if(!stmt.pStmt) toss("Stmt has been closed.");
        return stmt;
    };

    /** Frees any memory explicitly allocated for the given
        Stmt object. Returns stmt. */
    const freeBindMemory = function(stmt){
        let m;
        while(undefined !== (m = stmt._allocs.pop())){
            _free(m);
        }
        return stmt;
    };
    
    Stmt.prototype = {
        /**
           "Finalizes" this statement. This is a no-op if the
           statement has already been finalizes. Returns
           undefined. Most methods in this class will throw if called
           after this is.
        */
        finalize: function(){
            if(this.pStmt){
                freeBindMemory(this);
                delete this.db._statements[this.pStmt];
                S.sqlite3_finalize(this.pStmt);
                delete this.pStmt;
                delete this.db;
            }
        },
        /** Clears all bound values. Returns this object.
            Throws if this statement has been finalized. */
        clearBindings: function(){
            freeBindMemory(affirmStmtOpen(this));
            S.sqlite3_clear_bindings(this.pStmt);
            return this;
        },
        /**
           Resets this statement so that it may be step()ed again
           from the beginning. Returns this object. Throws if this
           statement has been finalized.

           If passed a truthy argument then this.clearBindings() is
           also called, otherwise any existing bindings, along with
           any memory allocated for them, are retained.
        */
        reset: function(alsoClearBinds){
            if(alsoClearBinds) this.clearBindings();
            S.sqlite3_reset(affirmStmtOpen(this).pStmt);
            return this;
        },
        /**
           Binds one or more values to its bindable parameters. It
           accepts 1 or 2 arguments:

           If passed a single argument, it must be either an array, an
           object, or a value of a bindable type (see below).

           If passed 2 arguments, the first one is the 1-based bind
           index or bindable parameter name and the second one must be
           a value of a bindable type.

           Bindable value types:

           - null or undefined is bound as NULL.

           - Numbers are bound as either doubles or integers: int64 if
             they are larger than 0xEFFFFFFF, else int32. Booleans are
             bound as integer 0 or 1. Note that doubles with no
             fractional part are bound as integers. It is not expected
             that that distinction is significant for the majority of
             clients due to sqlite3's data typing model. This API does
             not currently support the BigInt type.

           - Strings are bound as strings (use bindAsBlob() to force
             blob binding).

           - buffers (blobs) are currently TODO but will be bound as
             blobs.

           If passed an array, each element of the array is bound at
           the parameter index equal to the array index plus 1
           (because arrays are 0-based but binding is 1-based).

           If passed an object, each object key is treated as a
           bindable parameter name. The object keys _must_ match any
           bindable parameter names, including any `$`, `@`, or `:`
           prefix. Because `$` is a legal identifier chararacter in
           JavaScript, that is the suggested prefix for bindable
           parameters.

           It returns this object on success and throws on
           error. Errors include:

           - Any bind index is out of range, a named bind parameter
             does not match, or this statement has no bindable
             parameters.

           - Any value to bind is of an unsupported type.

           - Passed no arguments or more than two.

           - The statement has been finalized.
        */
        bind: function(/*[ndx,] value*/){
            if(!this.parameterCount){
                toss("This statement has no bindable parameters.");
            }
            let ndx, arg;
            switch(arguments.length){
                case 1: ndx = 1; arg = arguments[0]; break;
                case 2: ndx = arguments[0]; arg = arguments[1]; break;
                default: toss("Invalid bind() arguments.");
            }
            affirmStmtOpen(this);
            if(null===arg || undefined===arg){
                /* bind NULL */
                return bindOne(this, ndx, BindType.null, arg);
            }
            else if(Array.isArray(arg)){
                /* bind each entry by index */
                if(1!==arguments.length){
                    toss("When binding an array, an index argument is not permitted.");
                }
                arg.forEach((v,i)=>bindOne(this, i+1, affirmSupportedBindType(v), v));
                return this;
            }
            else if('object'===typeof arg/*null was checked above*/){
                /* bind by name */
                if(1!==arguments.length){
                    toss("When binding an object, an index argument is not permitted.");
                }
                Object.keys(arg)
                    .forEach(k=>bindOne(this, k,
                                        affirmSupportedBindType(arg[k]),
                                        arg[k]));
                return this;
            }else{
                return bindOne(this, ndx,
                               affirmSupportedBindType(arg), arg);
            }
            toss("Should not reach this point.");
        },
        /**
           Special case of bind() which binds the given value
           using the BLOB binding mechanism instead of the default
           selected one for the value. The ndx may be a numbered
           or named bind index. The value must be of type string,
           buffer, or null/undefined (both treated as null).

            If passed a single argument, a bind index of 1 is assumed.
        */
        bindAsBlob: function(ndx,arg){
            affirmStmtOpen(this);
            if(1===arguments.length){
                ndx = 1;
                arg = arguments[0];
            }
            const t = affirmSupportedBindType(arg);
            if(BindTypes.string !== t && BindTypes.blob !== t
               && BindTypes.null !== t){
                toss("Invalid value type for bindAsBlob()");
            }
            return bindOne(this, ndx, BindType.blob, arg);
        }
    };

    /** OO binding's namespace. */
    const SQLite3 = {
        version: {
            lib: sqlite3.sqlite3_libversion(),
            ooApi: "0.0.1"
        },
        DB,
        Stmt,
        /**
           Reports whether a given compile-time option, named by the
           given argument.

           If optName is an array then it is expected to be a list of
           compilation options and this function returns an object
           which maps each such option to true or false. That object
           is returned.

           If optName is an object, its keys are expected to be
           compilation options and this function sets each entry to
           true or false. That object is returned.

           If passed no arguments then it returns an object mapping
           all known compilation options to their compile-time values,
           or true if the are defined with no value.

           In all other cases it returns true if the option was active
           when when compiling the sqlite3 module, else false.

           Compile-time option names may optionally include their
           "SQLITE_" prefix. When it returns an object of all options,
           the prefix is elided.
        */
        compileOptionUsed: function f(optName){
            if(!arguments.length){
                if(!f._opt){
                    f._rx = /^([^=]+)=(.+)/;
                    f._rxInt = /^-?\d+/;
                    f._opt = function(opt, rv){
                        const m = f._rx.exec(opt);
                        rv[0] = (m ? m[1] : opt);
                        rv[1] = m ? (f._rxInt.test(m[2]) ? +m[2] : m[2]) : true;
                    };                    
                }
                const rc = {}, ov = [0,0];
                let i = 0;
                while((k = S.sqlite3_compileoption_get(i++))){
                    f._opt(k,ov);
                    rc[ov[0]] = ov[1];
                }
                return rc;
            }
            else if(Array.isArray(optName)){
                const rc = {};
                optName.forEach((v)=>{
                    rc[v] = S.sqlite3_compileoption_used(v);
                });
                return rc;
            }
            else if('object' === typeof optName){
                Object.keys(optName).forEach((k)=> {
                    optName[k] = S.sqlite3_compileoption_used(k);
                });
                return optName;
            }
            return (
                'string'===typeof optName
            ) ? !!S.sqlite3_compileoption_used(optName) : false;
        }
    };
    
    namespace.sqlite3 = sqlite3;
    namespace.SQLite3 = SQLite3;
})(self/*worker or window*/);
