import { upnpNat, NatAPI } from '@achingbrain/nat-port-mapper'
import { logger } from '@libp2p/logger'
import { fromNodeAddress } from '@multiformats/multiaddr'
import { isBrowser } from 'wherearewe'
import isPrivateIp from 'private-ip'
import * as pkg from './version.js'
import { CodeError } from '@libp2p/interfaces/errors'
import { codes } from './errors.js'
import { isLoopback } from '@libp2p/utils/multiaddr/is-loopback'
import type { Startable } from '@libp2p/interfaces/startable'
import type { TransportManager } from '@libp2p/interface-transport'
import type { PeerId } from '@libp2p/interface-peer-id'
import type { AddressManager } from '@libp2p/interface-address-manager'

const log = logger('libp2p:nat')
const DEFAULT_TTL = 7200

function highPort (min = 1024, max = 65535): number {
  return Math.floor(Math.random() * (max - min + 1) + min)
}

export interface PMPOptions {
  /**
   * Whether to enable PMP as well as UPnP
   */
  enabled?: boolean
}

export interface NatManagerInit {
  /**
   * Whether to enable the NAT manager
   */
  enabled: boolean

  /**
   * Pass a value to use instead of auto-detection
   */
  externalAddress?: string

  /**
   * Pass a value to use instead of auto-detection
   */
  localAddress?: string

  /**
   * A string value to use for the port mapping description on the gateway
   */
  description?: string

  /**
   * How long UPnP port mappings should last for in seconds (minimum 1200)
   */
  ttl?: number

  /**
   * Whether to automatically refresh UPnP port mappings when their TTL is reached
   */
  keepAlive: boolean

  /**
   * Pass a value to use instead of auto-detection
   */
  gateway?: string
}

export interface NatManagerComponents {
  peerId: PeerId
  transportManager: TransportManager
  addressManager: AddressManager
}

export class NatManager implements Startable {
  private readonly components: NatManagerComponents
  private readonly enabled: boolean
  private readonly externalAddress?: string
  private readonly localAddress?: string
  private readonly description: string
  private readonly ttl: number
  private readonly keepAlive: boolean
  private readonly gateway?: string
  private started: boolean
  private client?: NatAPI

  constructor (components: NatManagerComponents, init: NatManagerInit) {
    this.components = components

    this.started = false
    this.enabled = init.enabled
    this.externalAddress = init.externalAddress
    this.localAddress = init.localAddress
    this.description = init.description ?? `${pkg.name}@${pkg.version} ${this.components.peerId.toString()}`
    this.ttl = init.ttl ?? DEFAULT_TTL
    this.keepAlive = init.keepAlive ?? true
    this.gateway = init.gateway

    if (this.ttl < DEFAULT_TTL) {
      throw new CodeError(`NatManager ttl should be at least ${DEFAULT_TTL} seconds`, codes.ERR_INVALID_PARAMETERS)
    }
  }

  isStarted (): boolean {
    return this.started
  }

  start (): void {
    // #TODO: is there a way to remove this? Seems like a hack
  }

  /**
   * Attempt to use uPnP to configure port mapping using the current gateway.
   *
   * Run after start to ensure the transport manager has all addresses configured.
   */
  afterStart (): void {
    if (isBrowser || !this.enabled || this.started) {
      return
    }

    this.started = true

    // done async to not slow down startup
    void this._start().catch((err) => {
      // hole punching errors are non-fatal
      log.error(err)
    })
  }

  async _start (): Promise<void> {
    const addrs = this.components.transportManager.getAddrs()

    for (const addr of addrs) {
      // try to open uPnP ports for each thin waist address
      const { family, host, port, transport } = addr.toOptions()

      if (!addr.isThinWaistAddress() || transport !== 'tcp') {
        // only bare tcp addresses
        // eslint-disable-next-line no-continue
        continue
      }

      if (isLoopback(addr)) {
        // eslint-disable-next-line no-continue
        continue
      }

      if (family !== 4) {
        // ignore ipv6
        // eslint-disable-next-line no-continue
        continue
      }

      const client = await this._getClient()
      const publicIp = this.externalAddress ?? await client.externalIp()
      const isPrivate = isPrivateIp(publicIp)

      if (isPrivate === true) {
        throw new Error(`${publicIp} is private - please set config.nat.externalIp to an externally routable IP or ensure you are not behind a double NAT`)
      }

      if (isPrivate == null) {
        throw new Error(`${publicIp} is not an IP address`)
      }

      const publicPort = highPort()

      log(`opening uPnP connection from ${publicIp}:${publicPort} to ${host}:${port}`)

      await client.map({
        publicPort,
        localPort: port,
        localAddress: this.localAddress,
        protocol: transport.toUpperCase() === 'TCP' ? 'TCP' : 'UDP'
      })

      this.components.addressManager.addObservedAddr(fromNodeAddress({
        family: 4,
        address: publicIp,
        port: publicPort
      }, transport))
    }
  }

  async _getClient (): Promise<NatAPI> {
    if (this.client != null) {
      return this.client
    }

    this.client = await upnpNat({
      description: this.description,
      ttl: this.ttl,
      keepAlive: this.keepAlive,
      gateway: this.gateway
    })

    return this.client
  }

  /**
   * Stops the NAT manager
   */
  async stop (): Promise<void> {
    if (isBrowser || this.client == null) {
      return
    }

    try {
      await this.client.close()
      this.client = undefined
    } catch (err: any) {
      log.error(err)
    }
  }
}
