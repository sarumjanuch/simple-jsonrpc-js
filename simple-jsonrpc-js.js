const { v4: UUIDv4 } = require('uuid');

const RPC_TIMEOUT = 5000;

const isUndefined = function (value) {
    return value === undefined;
};

const nextId = function () {
    return UUIDv4();
};

const isArray = Array.isArray;

const isObject = function (value) {
    const type = typeof value;
    return value != null && (type === 'object' || type === 'function');
};

const isFunction = function (target) {
    return typeof target === 'function'
};

const isString = function (value) {
    return typeof value === 'string';
};

const isError = function (message) {
    return !!message.error;
};

const isPromise = function (thing) {
    return !!thing && typeof thing.then === 'function';
};

const isEmpty = function (value) {
    if (isObject(value)) {
        for (const idx in value) {
            if (value.hasOwnProperty(idx)) {
                return false;
            }
        }
        return true;
    }
    if (isArray(value)) {
        return !value.length;
    }
    return !value;
};

const isRequest = function (message) {
    return !!message.method;
};

const isResponse = function (message) {
    return message.hasOwnProperty('result') && message.hasOwnProperty('id');
};

const forEach = function (target, callback) {
    if (isArray(target)) {
        return target.map(callback);
    } else {
        for (const _key in target) {
            if (target.hasOwnProperty(_key)) {
                callback(target[_key]);
            }
        }
    }
};

const clone = function (value) {
    return JSON.parse(JSON.stringify(value));
};

const ERRORS = {
    "PARSE_ERROR":      {
        "code":    -32700,
        "message": "Invalid JSON was received by the server. An error occurred on the server while parsing the JSON text."
    },
    "INVALID_REQUEST":  {
        "code":    -32600,
        "message": "Invalid Request. The JSON sent is not a valid Request object."
    },
    "METHOD_NOT_FOUND": {
        "code":    -32601,
        "message": "Method not found. The method does not exist / is not available."
    },
    "INVALID_PARAMS":   {
        "code":    -32602,
        "message": "Invalid params. Invalid method parameter(s)."
    },
    "INTERNAL_ERROR":   {
        "code":    -32603,
        "message": "Internal error. Internal JSON-RPC error."
    },
    "REQUEST_TIMEOUT":  {
        "code":    -32099,
        "message": `Request has timed-out as not response was received in ${RPC_TIMEOUT} ms.`
    }
};

function ServerError(code, message, data) {
    this.message = message || "";
    this.code = code || -32000;

    if (Boolean(data)) {
        this.data = data;
    }
}

ServerError.prototype = new Error();

const isMain = typeof window === 'undefined';

class JsonRpc {
    constructor() {
        this.dispatcher = new Map();
        this.waits = new Map();

    }

    setError(jsonrpcError, exception) {
        let error = clone(jsonrpcError);
        if (!!exception) {
            if (isObject(exception)) {
                error.data = exception.data || exception.message || jsonrpcError.message;
            }  else if (isString(exception)) {
                error.data = exception;
            }

            if (exception instanceof ServerError) {
                error = {
                    message: exception.message,
                    code:    exception.code
                };
                if (exception.hasOwnProperty('data')) {
                    error.data = exception.data;
                }
            }
        }
        return error;
    }

    beforeResolve(message, ...rest) {
        let promises = [];
        if (isArray(message)) {
            forEach(message, (msg) => {
                promises.push(this.resolver(msg));
            });
        } else if (isObject(message)) {
            promises.push(this.resolver(message, ...rest));
        }

        return Promise.all(promises)
            .then(result => {

                let toStream = [];
                forEach(result, r => {
                    if (!isUndefined(r)) {
                        toStream.push(r);
                    }
                });

                if (toStream.length === 1) {
                    this.toStream(JSON.stringify(toStream[0]), ...rest);
                } else if (toStream.length > 1) {
                    this.toStream(JSON.stringify(toStream), ...rest);
                }
                return result;
            }).catch(e => {
                this.toStream(JSON.stringify(e), ...rest)
            });
    }

    resolver(message, ...rest) {
        try {
            if (isError(message)) {
                return this.rejectRequest(message);
            } else if (isResponse(message)) {
                return this.resolveRequest(message);
            } else if (isRequest(message)) {
                return this.handleRemoteRequest(message, ...rest);
            } else {
                return Promise.reject({
                    "id":      null,
                    "jsonrpc": "2.0",
                    "error":   this.setError(ERRORS.INVALID_REQUEST)
                });
            }
        } catch (e) {
            console.error('Resolver error:' + e.message, e);
            return Promise.reject(e);
        }
    }

    rejectRequest(error) {
        if (this.waits.has(error.id)) {
            clearTimeout(this.waits.get(error.id).timeout);
            this.waits.get(error.id).reject(error.error);
            this.waits.delete(error.id);
        } else {
            console.log('Unknown request', error);
        }
    }

    resolveRequest(result) {
        if (this.waits.has(result.id)) {
            clearTimeout(this.waits.get(result.id).timeout);
            this.waits.get(result.id).resolve(result.result);
            delete this.waits.delete(result.id);
        } else {
            console.log('unknown request', result);
        }
    }

    handleRemoteRequest(request, ...rest) {
        if (!this.dispatcher.has(request.method)) {
            return Promise.reject({
                "jsonrpc": "2.0",
                "id":      request.id,
                "error":   this.setError(ERRORS.METHOD_NOT_FOUND, {
                    message: request.method
                })
            });
        }
        try {
            let result;

            if (request.hasOwnProperty('params')) {
                if (this.dispatcher.get(request.method).params === "pass") {
                    result = this.dispatcher.get(request.method).fn.call(null, request.params, ...rest);
                } else if (isArray(request.params)) {
                    result = this.dispatcher.get(request.method).fn.apply(null, request.params, ...rest);
                } else if (isObject(request.params)) {
                    if (this.dispatcher.get(request.method).params instanceof Array) {
                        let argsValues = [];
                        this.dispatcher.get(request.method).params.forEach(arg => {

                            if (request.params.hasOwnProperty(arg)) {
                                argsValues.push(request.params[arg]);
                                delete request.params[arg];
                            } else {
                                argsValues.push(undefined);
                            }
                        });

                        if (Object.keys(request.params).length > 0) {
                            return Promise.reject({
                                "jsonrpc": "2.0",
                                "id":      request.id,
                                "error":   this.setError(ERRORS.INVALID_PARAMS, {
                                    message: "Params: " + Object.keys(request.params).toString() + " not used"
                                })
                            });
                        } else {
                            result = this.dispatcher.get(request.method).fn.apply(null, argsValues.concat(...rest));
                        }
                    } else {
                        return Promise.reject({
                            "jsonrpc": "2.0",
                            "id":      request.id,
                            "error":   this.setError(ERRORS.INVALID_PARAMS, "Undeclared arguments of the method " + request.method)
                        });
                    }
                }
            } else {
                result = this.dispatcher.get(request.method).fn(...rest);
            }

            if (request.hasOwnProperty('id')) {
                if (isPromise(result)) {
                    return result.then(res => {
                        if (isUndefined(res)) {
                            res = true;
                        }
                        return {
                            "jsonrpc": "2.0",
                            "id":      request.id,
                            "result":  res
                        };
                    }).catch(e => {
                        return {
                            "jsonrpc": "2.0",
                            "id":      request.id,
                            "error":   this.setError(ERRORS.INTERNAL_ERROR, e)
                        };
                    });
                } else {

                    if (isUndefined(result)) {
                        result = true;
                    }

                    return Promise.resolve({
                        "jsonrpc": "2.0",
                        "id":      request.id,
                        "result":  result
                    });
                }
            } else {
                return Promise.resolve(); //nothing, it notification
            }
        } catch (e) {
            return Promise.reject({
                "jsonrpc": "2.0",
                "id":      request.id,
                "error":   this.setError(ERRORS.INTERNAL_ERROR, e)
            });
        }
    }

    _notification(method, params) {
        const message = {
            "jsonrpc": "2.0",
            "method":  method,
            "params":  params
        };

        if (isObject(params) && !isEmpty(params)) {
            message.params = params;
        }

        return message;
    }

    _call(method, params) {
        const self = this;
        const id = nextId();
        const message = {
            "jsonrpc": "2.0",
            "method":  method,
            "id":      id
        };

        if (isObject(params) && !isEmpty(params)) {
            message.params = params;
        }

        return {
            promise: new Promise((resolve, reject) => {
                this.waits.set(id.toString(), {
                    resolve: resolve,
                    reject:  reject,
                    timeout: setTimeout(() => {
                        self.rejectRequest({
                            "id":      id,
                            "jsonrpc": "2.0",
                            "error":   this.setError(ERRORS.REQUEST_TIMEOUT)
                        });
                    }, RPC_TIMEOUT)
                });
            }),
            message: message
        };
    }

    dispatch(functionName, paramsNameFn, fn) {

        if (isString(functionName) && paramsNameFn === "pass" && isFunction(fn)) {
            this.dispatcher.set(functionName, {
                fn:     fn,
                params: paramsNameFn
            });
        } else if (isString(functionName) && isArray(paramsNameFn) && isFunction(fn)) {
            this.dispatcher.set(functionName, {
                fn:     fn,
                params: paramsNameFn
            });
        } else if (isString(functionName) && isFunction(paramsNameFn) && isUndefined(fn)) {
            this.dispatcher.set(functionName, {
                fn:     paramsNameFn,
                params: null
            });
        } else {
            throw new Error('Missing required argument: functionName - string, paramsNameFn - string or function');
        }
    }

    off(functionName) {
        delete this.dispatcher.delete(functionName);
    }

    on(...args){
        this.dispatch.call(this, ...args);
    }

    call(method, params, ...userData) {
        const _call = this._call(method, params);
        try {
            this.toStream(JSON.stringify(_call.message),...userData);
        } catch (e) {
            this.rejectRequest({
                "id":      _call.message.id,
                "jsonrpc": "2.0",
                "error":   this.setError(ERRORS.INTERNAL_ERROR)
            });
        }
        return _call.promise;
    }

    notify(method, params, appData) {
        this.toStream(JSON.stringify(this._notification(method, params)), appData);
    }

    batch(requests) {
        const promises = [];
        const message = [];

        forEach(requests, (req) => {
            if (req.hasOwnProperty('call')) {
                const _call = this.call(req.call.method, req.call.params);
                message.push(_call.message);
                //TODO: batch reject if one promise reject, so catch reject and resolve error as result;
                promises.push(_call.promise.then(function (res) {
                    return res;
                }, function (err) {
                    return err;
                }));
            } else if (req.hasOwnProperty('notification')) {
                message.push(this.notify(req.notification.method, req.notification.params));
            }
        });

        this.toStream(JSON.stringify(message));
        return Promise.all(promises);
    }

    messageHandler(rawMessage, ...rest) {
        try {
            if (isObject(rawMessage)) {
                return this.beforeResolve(rawMessage, ...rest);
            }
            const message = JSON.parse(rawMessage);
            return this.beforeResolve(message, ...rest);
        } catch (e) {
            console.log("Error in messageHandler(): ", e);
            this.toStream(JSON.stringify({
                "id":      null,
                "jsonrpc": "2.0",
                "error":   ERRORS.PARSE_ERROR
            }),...rest);
            return Promise.reject(e);
        }
    }
    /**
     * Static method for simple_jsonrpc for creating a simple_jsonrpc() instance pre-configured
     * for use in a browser, with JSON-RPC over HTTP using standard XHR.
     *
     * Example:
     *
     *     var rpc = simple_jsonrpc.connect_xhr("http://rpc.example.com:8888");
     *     rpc.call("get_account", ["johndoe"]).then(function(res) {
     *         console.log("johndoe full name:", res.full_name)
     *     })
     *
     */
    connect_xhr(rpc_url, rpc_config) {
        if ( typeof rpc_url === "undefined" || rpc_url === null ) rpc_url = "/";
        if ( typeof rpc_config === "undefined" || rpc_config === null ) rpc_config = {};

        if ( !('content-type' in rpc_config) ) rpc_config['content-type'] = 'application/json; charset=utf-8';
        if ( !('method' in rpc_config) ) rpc_config.method = 'POST';
        if ( !('onerror' in rpc_config) ) rpc_config.onerror = console.error;
        const jrpc = new JsonRpc();

        jrpc.toStream = function(_msg){
            const xhr = new XMLHttpRequest();
            xhr.onreadystatechange = function() {
                if (this.readyState != 4) return;

                try {
                    JSON.parse(this.responseText);
                    jrpc.messageHandler(this.responseText);
                }
                catch (e){
                    rpc_config.onerror(e);
                }
            };

            xhr.open(rpc_config.method, rpc_url, true);
            xhr.setRequestHeader('Content-type', rpc_config['content-type']);
            xhr.send(_msg);
        };

        return jrpc;
    };
}

module.exports = {
    JsonRpc
};
