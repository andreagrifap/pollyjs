import http from 'http';
import zlib from 'zlib';

import { URL } from '@pollyjs/utils';

const NATIVE_REQUEST = Symbol();
const NATIVE_END = Symbol();

const LISTENERS = Symbol();

export default class TransportWrapper {
  constructor(transport, { name, adapter }) {
    this.name = name;
    this.adapter = adapter;
    this.transport = transport;
  }

  isPatched() {
    return !!this.transport[NATIVE_REQUEST];
  }

  patch() {
    // make sure it's not already patched
    this.adapter.assert(
      `Transport ${this.name} can not be patched multiple times`,
      !this.isPatched()
    );

    this.transport[NATIVE_REQUEST] = this.transport.request;
    this.transport.request = this.createRequestWrapper();
  }

  restore() {
    this.adapter.assert(
      `Cannot restore unpatched transport ${this.name}`,
      this.isPatched()
    );

    this.transport.request = this.transport[NATIVE_REQUEST];
    delete this.transport[NATIVE_REQUEST];
  }

  getHttpResponseData(res) {
    return new Promise(resolve => {
      let stream;

      switch (res.headers['content-encoding']) {
        case 'gzip':
        case 'compress':
        case 'deflate':
          stream = res.pipe(zlib.createUnzip());
          delete res.headers['content-encoding'];
          break;
        default:
          stream = res;
      }

      const resBuffer = [];

      stream.on('data', chunk => resBuffer.push(chunk));

      stream.on('end', () => {
        const data = Buffer.concat(resBuffer).toString('utf8');

        resolve(data);
      });
    });
  }

  async passthrough(req) {
    const res = await new Promise(resolve => {
      req.once('response', response => resolve(response));
      req[NATIVE_END].call(req);
    });

    const data = await this.getHttpResponseData(res);

    const { headers, statusCode } = res;

    return {
      headers,
      statusCode,
      data
    };
  }

  async respond(req, response) {
    Object.keys(req[LISTENERS]).forEach(eventName => {
      const listeners = req[LISTENERS][eventName];

      listeners.forEach(listener => req.on(eventName, listener));
    });

    const fakeSocket = { readable: false };
    const msg = new http.IncomingMessage(fakeSocket);

    msg.statusCode = response.statusCode;
    req.emit('response', msg);

    for (const h in response.headers) {
      msg.headers[h] = response.headers[h];
    }

    let body = response.body;

    if (typeof body === 'undefined') {
      body = [];
    }

    msg.emit('data', Buffer.from(body));
    msg.emit('end');

    req.emit('prefinish');
    req.emit('finish');
  }

  createRequestWrapper() {
    const wrapper = this;
    const { adapter, transport } = wrapper;

    return (...args) => {
      /**
       * args could be (url, options, callback) or (options, callback) depending on nodejs version
       * We don't need to wrap callback we can just emit 'response' event on ClientRequest
       * and it's more reliable to collect request information from ClientRequest instance
       * We don't need to store args
       */

      const req = transport[NATIVE_REQUEST].call(transport, ...args);

      const chunks = [];

      const originalWrite = req.write;

      req.write = (chunk, encoding, callback) => {
        // TODO : handle encoding
        chunks.push(chunk);

        originalWrite.call(req, chunk, encoding, callback);
      };

      req[NATIVE_END] = req.end;
      req.end = (chunk, encoding, callback) => {
        if (typeof chunk === 'function') {
          callback = chunk;
          chunk = null;
        } else if (typeof encoding === 'function') {
          callback = encoding;
          encoding = null;
        }

        if (chunk) {
          req.write(chunk, encoding);
        }

        if (typeof callback === 'function') {
          // we don't call original `end` yet but no need to carry callback around when we do
          // this is what happens in original `end`
          req.once('finish', callback);
        }

        req[LISTENERS] = ['response'].reduce((acc, eventName) => {
          const listeners = req.listeners(eventName);

          // unsubscribe these listeners, so that we break the connection between caller and `req`
          // until we decide what to do in next steps
          req.removeAllListeners(eventName);

          acc[eventName] = listeners;

          return acc;
        }, {});

        const headers = req.getHeaders();
        const path = req.path;
        const method = req.method;
        const host = headers.host;

        // TODO : handle encoding
        const body = chunks.join();
        const [hostname, port = 80] = host.split(':');

        const parsedUrl = new URL('');

        parsedUrl.set('protocol', req.agent.protocol);
        parsedUrl.set('pathname', path);
        parsedUrl.set('hostname', hostname);
        if (port !== 80) {
          parsedUrl.set('port', port);
        }

        const url = parsedUrl.href;

        adapter.handleRequest({
          url,
          method,
          headers,
          body: body.length > 0 ? body : undefined,
          requestArguments: [wrapper, req]
        });
      };

      return req;
    };
  }
}
