"use strict";

const crypto = require("crypto");
const net = require("net");

function parseJson(value, fallback = null) {
  if (!value || typeof value !== "string") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseLaunchArgs(argv = process.argv) {
  const keyed = {};
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key || !key.startsWith("-")) continue;
    keyed[key.replace(/^-+/, "")] = argv[index + 1];
    index += 1;
  }

  return {
    port: keyed.port || argv[3] || null,
    pluginUUID: keyed.pluginUUID || argv[5] || null,
    registerEvent: keyed.registerEvent || argv[7] || null,
    info: parseJson(keyed.info || argv[9], {})
  };
}

class NativeWebSocketAdapter {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.socket.addEventListener("open", () => this.onopen && this.onopen());
    this.socket.addEventListener("message", (event) => this.onmessage && this.onmessage({ data: event.data }));
    this.socket.addEventListener("close", () => this.onclose && this.onclose());
    this.socket.addEventListener("error", (event) => this.onerror && this.onerror(event.error || event));
  }

  send(data) {
    this.socket.send(data);
  }

  close() {
    this.socket.close();
  }
}

class RawWebSocketAdapter {
  constructor(url) {
    this.url = new URL(url);
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.handshakeComplete = false;
    this.fragmentBuffers = [];
    this.fragmentOpcode = null;
    this.connect();
  }

  connect() {
    const port = Number(this.url.port);
    this.socket = net.connect({ host: this.url.hostname, port }, () => {
      const key = crypto.randomBytes(16).toString("base64");
      const requestPath = `${this.url.pathname || "/"}${this.url.search || ""}`;
      const request = [
        `GET ${requestPath} HTTP/1.1`,
        `Host: ${this.url.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "\r\n"
      ].join("\r\n");
      this.socket.write(request);
    });

    this.socket.on("data", (chunk) => this.handleData(chunk));
    this.socket.on("close", () => this.onclose && this.onclose());
    this.socket.on("error", (error) => this.onerror && this.onerror(error));
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.handshakeComplete) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      this.buffer = this.buffer.subarray(headerEnd + 4);
      if (!/^HTTP\/1\.1 101/i.test(header)) {
        this.onerror && this.onerror(new Error(`WebSocket upgrade failed: ${header.split("\r\n")[0]}`));
        this.close();
        return;
      }
      this.handshakeComplete = true;
      this.onopen && this.onopen();
    }

    this.parseFrames();
  }

  parseFrames() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.buffer.length < offset + 2) return;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) return;
        const bigLength = this.buffer.readBigUInt64BE(offset);
        if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.onerror && this.onerror(new Error("WebSocket frame is too large"));
          this.close();
          return;
        }
        length = Number(bigLength);
        offset += 8;
      }

      let mask = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        mask = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (this.buffer.length < offset + length) return;

      let payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);

      if (mask) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4];
        }
      }

      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this.sendFrame(0xA, payload);
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) {
        if (fin) {
          this.onmessage && this.onmessage({ data: payload.toString("utf8") });
        } else {
          this.fragmentOpcode = opcode;
          this.fragmentBuffers = [payload];
        }
        continue;
      }
      if (opcode === 0x0 && this.fragmentOpcode) {
        this.fragmentBuffers.push(payload);
        if (fin) {
          const complete = Buffer.concat(this.fragmentBuffers);
          this.fragmentBuffers = [];
          this.fragmentOpcode = null;
          this.onmessage && this.onmessage({ data: complete.toString("utf8") });
        }
      }
    }
  }

  send(data) {
    this.sendFrame(0x1, Buffer.from(String(data), "utf8"));
  }

  sendFrame(opcode, payload) {
    if (!this.socket || this.socket.destroyed) return;
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | length;
    } else if (length <= 0xffff) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    header[0] = 0x80 | opcode;

    const mask = crypto.randomBytes(4);
    const maskedPayload = Buffer.from(payload);
    for (let index = 0; index < maskedPayload.length; index += 1) {
      maskedPayload[index] ^= mask[index % 4];
    }
    this.socket.write(Buffer.concat([header, mask, maskedPayload]));
  }

  close() {
    if (this.socket && !this.socket.destroyed) this.socket.end();
  }
}

function createWebSocket(url) {
  if (typeof globalThis.WebSocket === "function") {
    return new NativeWebSocketAdapter(url);
  }
  return new RawWebSocketAdapter(url);
}

class StreamDockConnection {
  constructor(args, handlers = {}) {
    this.args = args;
    this.handlers = handlers;
    this.socket = null;
  }

  connect() {
    if (!this.args.port || !this.args.pluginUUID || !this.args.registerEvent) {
      throw new Error("Missing StreamDock launch arguments");
    }

    this.socket = createWebSocket(`ws://127.0.0.1:${this.args.port}`);
    this.socket.onopen = () => {
      this.sendRaw({ uuid: this.args.pluginUUID, event: this.args.registerEvent });
      this.handlers.open && this.handlers.open();
    };
    this.socket.onmessage = (event) => {
      const data = parseJson(String(event.data), null);
      if (!data) return;
      this.handlers.message && this.handlers.message(data);
    };
    this.socket.onerror = (error) => this.handlers.error && this.handlers.error(error);
    this.socket.onclose = () => this.handlers.close && this.handlers.close();
  }

  sendRaw(payload) {
    if (!this.socket) return;
    this.socket.send(JSON.stringify(payload));
  }

  setImage(context, image) {
    this.sendRaw({
      event: "setImage",
      context,
      payload: {
        target: 0,
        image
      }
    });
  }

  setTitle(context, title) {
    this.sendRaw({
      event: "setTitle",
      context,
      payload: {
        target: 0,
        title
      }
    });
  }

  setSettings(context, payload) {
    this.sendRaw({
      event: "setSettings",
      context,
      payload
    });
  }

  showOk(context) {
    this.sendRaw({ event: "showOk", context });
  }

  showAlert(context) {
    this.sendRaw({ event: "showAlert", context });
  }

  sendToPropertyInspector(action, context, payload) {
    this.sendRaw({
      action,
      event: "sendToPropertyInspector",
      context,
      payload
    });
  }
}

module.exports = {
  parseLaunchArgs,
  createWebSocket,
  StreamDockConnection
};
