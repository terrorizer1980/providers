const pump = require('pump')
const RpcEngine = require('json-rpc-engine')
const createErrorMiddleware = require('./createErrorMiddleware')
const createIdRemapMiddleware = require('json-rpc-engine/src/idRemapMiddleware')
const createJsonRpcStream = require('json-rpc-middleware-stream')
const LocalStorageStore = require('obs-store')
const asStream = require('obs-store/lib/asStream')
const ObjectMultiplex = require('obj-multiplex')
const util = require('util')
const SafeEventEmitter = require('safe-event-emitter')
const { getSiteMetadata, createObjectTransformStream } = require('./siteMetadata')

module.exports = MetamaskInpageProvider

util.inherits(MetamaskInpageProvider, SafeEventEmitter)

const promiseCallback = (resolve, reject) => (error, response) => {
  error || response.error
  ? reject(error || response.error)
  : resolve(response)
}

function MetamaskInpageProvider (connectionStream) {
  const self = this

  document.addEventListener('DOMContentLoaded', () => {
    self._siteMetadata = getSiteMetadata()
  })

  // TODO:1193
  // self._isConnected = undefined

  // TODO:synchronous
  // self.selectedAddress = undefined
  // self.networkVersion = undefined

  // super constructor
  SafeEventEmitter.call(self)

  // setup connectionStream multiplexing
  const mux = self.mux = new ObjectMultiplex()
  pump(
    connectionStream,
    mux,
    connectionStream,
    logStreamDisconnectWarning.bind(this, 'MetaMask')
  )

  // subscribe to metamask public config (one-way)
  self.publicConfigStore = new LocalStorageStore({ storageKey: 'MetaMask-Config' })

  // TODO:synchronous
  // // Emit events for some state changes
  // self.publicConfigStore.subscribe(function (state) {

  //   Emit accountsChanged event on account change
  //   if ('selectedAddress' in state && state.selectedAddress !== self.selectedAddress) {
  //     self.selectedAddress = state.selectedAddress
  //     self.emit('accountsChanged', [self.selectedAddress])
  //   }

  //   Emit networkChanged event on network change
  //   if ('networkVersion' in state && state.networkVersion !== self.networkVersion) {
  //     self.networkVersion = state.networkVersion
  //     self.emit('networkChanged', state.networkVersion)
  //   }
  // })

  pump(
    mux.createStream('publicConfig'),
    asStream(self.publicConfigStore),
    logStreamDisconnectWarning.bind(this, 'MetaMask PublicConfigStore')
  )

  // ignore phishing warning message (handled elsewhere)
  mux.ignoreStream('phishing')

  const metadataTransformStream = createObjectTransformStream(obj => {
    obj._siteMetadata = (
      self._siteMetadata
      ? self._siteMetadata
      : { name: null, icon: null }
    )
    return obj
  })

  // connect to async provider
  const jsonRpcConnection = createJsonRpcStream()
  pump(
    jsonRpcConnection.stream,
    metadataTransformStream, // add site metadata to outbound requests
    mux.createStream('provider'),
    jsonRpcConnection.stream,
    logStreamDisconnectWarning.bind(this, 'MetaMask RpcProvider')
  )

  // handle sendAsync requests via dapp-side rpc engine
  const rpcEngine = new RpcEngine()
  rpcEngine.push(createIdRemapMiddleware())
  rpcEngine.push(createErrorMiddleware())
  rpcEngine.push(jsonRpcConnection.middleware)
  self.rpcEngine = rpcEngine

  // forward json rpc notifications
  jsonRpcConnection.events.on('notification', function(payload) {
    self.emit('data', null, payload)
  })

  // EIP-1193 subscriptions
  self.on('data', (error, { method, params }) => {
    if (!error && method === 'eth_subscription') {
      self.emit('notification', params.result)
    }
  })

  // Work around for https://github.com/metamask/metamask-extension/issues/5459
  // drizzle accidently breaking the `this` reference
  self.enable = self.enable.bind(self)
  self.send = self.send.bind(self)
  self.sendAsync = self.sendAsync.bind(self)
  self._sendAsync = self._sendAsync.bind(self)
  self._requestAccounts = self._requestAccounts.bind(self)

  // indicate that we've connected, for EIP-1193 compliance
  setTimeout(() => self.emit('connect'))
}

/**
 * Backwards compatibility method, to be deprecated.
 */
MetamaskInpageProvider.prototype.enable = function () {
  const self = this
  console.warn('MetaMask: ethereum.enable() is deprecated and may be removed in the future. Please use ethereum.send(\'eth_requestAccounts\'). For more details, see: https://eips.ethereum.org/EIPS/eip-1102')
  return self._requestAccounts()
}

/**
 * EIP-1102 eth_requestAccounts
 * Implemented here to remain EIP-1102-compliant with ocap permissions.
 */
MetamaskInpageProvider.prototype._requestAccounts = function () {
  const self = this

  return new Promise((resolve, reject) => {
    self._sendAsync(
      {
        jsonrpc: '2.0',
        method: 'wallet_requestPermissions',
        params: [{ eth_accounts: {} }],
      },
      promiseCallback(resolve, reject)
    )
  })
  .then(() => {
    return new Promise((resolve, reject) => {
      self._sendAsync(
        {
          method: 'eth_accounts',
        },
        (error, response) => {
          if (error || response.error) {
            reject(error || response.error)
          } else if (
            !Array.isArray(response.result) || response.result.length < 1
          ) {
            reject('No accounts available.') // TODO:bug handle gracefully
          } else {
            resolve(response.result)
          }
        }
      )
    })
  })
  .catch(error => error)
}

/**
 * EIP-1193 send, with backwards compatibility.
 */
MetamaskInpageProvider.prototype.send = function (methodOrPayload, paramsOrCallback) {
  const self = this

  // Web3 1.0 backwards compatibility
  if (
    !Array.isArray(methodOrPayload) &&
    typeof methodOrPayload === 'object' &&
    typeof paramsOrCallback === 'function'
  ) {
    self._sendAsync(payload, callback)
    return
  }
  
  // Per our docs as of <= 5/31/2019, send accepts a payload and returns
  // a promise, however per EIP-1193, send should accept a method string
  // and params array. Here we support both.
  let method, params
  if (
    typeof methodOrPayload === 'object' &&
    typeof methodOrPayload.method === 'string'
  ) {
    method = methodOrPayload.method
    params = methodOrPayload.params
  } else if (typeof methodOrPayload === 'string') {
    method = methodOrPayload
    params = paramsOrCallback
  } else {
    // throw not-supported error
    throw new Error(
      `The MetaMask Ethereum provider does not support your given parameters. Please use ethereum.send(method: string, params: Array<any>). For more details, see: https://eips.ethereum.org/EIPS/eip-1193`
    )
  }

  if (!Array.isArray(params)) {
    if (params) params = [params]
    else params = []
  }

  if (method === 'eth_requestAccounts') return self._requestAccounts()

  return new Promise((resolve, reject) => {
    try {
      self._sendAsync(
        { jsonrpc: '2.0', method, params },
        promiseCallback(resolve, reject)
      )
    } catch (error) {
      reject(error)
    }
  })
}

/**
 * Web3 1.0 backwards compatibility method.
 */
MetamaskInpageProvider.prototype.sendAsync = function (payload, cb) {
  const self = this
  console.warn('MetaMask: ethereum.sendAsync(...) is deprecated and may be removed in the future. Please use ethereum.send(method: string, params: Array<any>). For more details, see: https://eips.ethereum.org/EIPS/eip-1193')
  self._sendAsync(payload, cb)
}

/**
 * Internal RPC method. Forwards requests to background via the RPC engine.
 * Also remap ids inbound and outbound.
 */
MetamaskInpageProvider.prototype._sendAsync = function (payload, cb) {
  const self = this

  if (payload.method === 'eth_signTypedData') {
    console.warn('MetaMask: This experimental version of eth_signTypedData will be deprecated in the next release in favor of the standard as defined in EIP-712. See https://git.io/fNzPl for more information on the new standard.')
  }

  if (payload.method === 'eth_requestAccounts') {
    self._requestAccounts()
      .then(result => cb(null, result))
      .catch(error => cb(error, null))
    return
  }

  self.rpcEngine.handle(payload, cb)
}

MetamaskInpageProvider.prototype.isConnected = function () {
  return true
}

MetamaskInpageProvider.prototype.isMetaMask = true

// TODO:1193
// MetamaskInpageProvider.prototype._onClose = function () {
//   if (this._isConnected === undefined || this._isConnected) {
//     this._provider.emit('close', {
//       code: 1011,
//       reason: 'Network connection error',
//     })
//   }
//   this._isConnected = false
// }

// util

function logStreamDisconnectWarning (remoteLabel, err) {
  let warningMsg = `MetamaskInpageProvider - lost connection to ${remoteLabel}`
  if (err) warningMsg += '\n' + err.stack
  console.warn(warningMsg)
  const listeners = this.listenerCount('error')
  if (listeners > 0) {
    this.emit('error', warningMsg)
  }
}
