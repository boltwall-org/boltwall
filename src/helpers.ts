/// <reference path="../node_modules/macaroons.js/lib/Macaroon.d.ts" />
const {
  MacaroonsBuilder,
  MacaroonsVerifier,
  MacaroonsConstants: { MACAROON_SUGGESTED_SECRET_LENGTH },
  verifier,
} = require('macaroons.js')
import dotenv from 'dotenv'
import Macaroon from 'macaroons.js/lib/Macaroon'
const lnService = require('ln-service')

import { LndRequest } from './typings/request'
import { InvoiceResponse } from './typings/invoice'

export function getEnvVars(): any {
  dotenv.config()
  return {
    PORT: process.env.PORT as string,
    OPEN_NODE_KEY: process.env.OPEN_NODE_KEY as string,
    LND_TLS_CERT: process.env.LND_TLS_CERT as string,
    LND_MACAROON: process.env.LND_MACAROON as string,
    SESSION_SECRET: process.env.LND_MACAROON as string,
    CAVEAT_KEY: process.env.CAVEAT_KEY as string,
    LND_SOCKET: process.env.LND_SOCKET as string,
  }
}

export function testEnvVars() {
  const {
    OPEN_NODE_KEY,
    LND_TLS_CERT,
    LND_MACAROON,
    LND_SOCKET,
    SESSION_SECRET,
  } = getEnvVars()

  // first check if we have a session secret w/ sufficient bytes
  if (
    !SESSION_SECRET ||
    SESSION_SECRET.length < MACAROON_SUGGESTED_SECRET_LENGTH
  )
    throw new Error(
      'Must have a SESSION_SECRET env var for signing macaroons with minimum lenght of 32 bytes.'
    )

  // next check lnd configs
  const lndConfigs = [LND_TLS_CERT, LND_MACAROON, LND_SOCKET]
  // if we have all lndConfigs then return true

  if (lndConfigs.every(config => config !== undefined)) return true

  // if we have no lnd configs but an OPEN_NODE_KEY then return true
  if (lndConfigs.every(config => config === undefined) && OPEN_NODE_KEY)
    return true

  // if we have some lnd configs but not all, throw that we're missing some
  if (lndConfigs.some(config => config === undefined))
    throw new Error(
      'Missing configs to connect to LND node. Need macaroon, socket, and tls cert.'
    )

  // otherwise we have no lnd configs and no OPEN_NODE_KEY
  // throw that there are no ln configs
  throw new Error(
    'No configs set in environment to connect to a lightning node. \
See README for instructions: https://github.com/bucko13/now-paywall'
  )
}

/*
 * Utility to create an invoice based on either an authenticated lnd grpc instance
 * or an opennode connection
 * @params {Object} req - express request object that either contains an lnd or opennode object
 * @returns {Object} invoice - returns an invoice with a payreq, id, description, createdAt, and
 */
export async function createInvoice({ lnd, opennode, body, ip }: LndRequest) {
  let { time, title, expiresAt, appName } = body // time in seconds

  if (!appName) appName = `[unknown application @ ${ip}]`

  if (!title) title = '[unknown data]'

  let invoice: InvoiceResponse
  console.log('creating invoice')
  const _description = `Access for ${time} seconds in ${appName} for requested data: ${title}`
  const tokens = time
  if (lnd) {
    const {
      request: payreq,
      id,
      description,
      created_at: createdAt,
      tokens: amount,
    } = await lnService.createInvoice({
      lnd: lnd,
      _description,
      expires_at: expiresAt,
      tokens,
    })
    invoice = { payreq, id, description, createdAt, amount }
  } else if (opennode) {
    const {
      lightning_invoice: { payreq },
      id,
      description,
      created_at: createdAt,
      amount,
    } = await opennode.createCharge({
      _description,
      amount: tokens,
      auto_settle: false,
    })
    invoice = { payreq, id, description, createdAt, amount }
  } else {
    throw new Error(
      'No lightning node information configured on request object'
    )
  }

  return invoice
}

/*
 * Given an invoice object and a request
 * we want to create a root macaroon with a third party caveat, which both need to be
 * satisfied in order to authenticate the macaroon
 * @params {invoice.id} - invoice must at least have an id for creating the 3rd party caveat
 * @params {Object} req - request object is needed for identification of the macaroon, in particular
 * the headers and the originating ip
 * @returns {Macaroon} - serialized macaroon object
 */

export async function createRootMacaroon(invoiceId: string, location: string) {
  if (!invoiceId)
    throw new Error(
      'Missing an invoice object with an id. Cannot create macaroon'
    )

  const { SESSION_SECRET: secret, CAVEAT_KEY: caveatKey } = getEnvVars()

  const publicIdentifier = 'session secret'
  // caveat is created to make sure invoice id matches when validating with this macaroon
  const { caveat } = getFirstPartyCaveat(invoiceId)
  const builder = new MacaroonsBuilder(
    location,
    secret,
    publicIdentifier
  ).add_first_party_caveat(caveat)

  // when protecting "local" content, i.e. this is being used as a paywall to protect
  // content in the same location as the middleware is implemented, then the third party
  // caveat is discharged by the current host as well, so location is the same for both.
  // In alternative scenarios, where now-paywall is being used to authenticate access at another source
  // then this will be different. e.g. see Prism Reader as an example
  const macaroon = builder
    .add_third_party_caveat(location, caveatKey, invoiceId)
    .getMacaroon()

  return macaroon.serialize()
}

/*
 * Checks the status of an invoice given an id
 * @params {express.request} - request object from expressjs
 * @params {req.query.id} invoiceId - id of invoice to check status of
 * @params {req.lnd} [lnd] - ln-service authenticated grpc object
 * @params {req.opennode} [opennode] - authenticated opennode object for communicating with OpenNode API
 * @returns {Object} - status - Object with status, amount, and payment request
 */

export async function checkInvoiceStatus(
  lnd: any,
  opennode: any,
  invoiceId: string
) {
  if (!invoiceId) throw new Error('Missing invoice id.')

  let status, amount, payreq
  if (lnd) {
    const invoiceDetails = await lnService.getInvoice({
      id: invoiceId,
      lnd: lnd,
    })
    status = invoiceDetails['is_confirmed'] ? 'paid' : 'unpaid'
    amount = invoiceDetails.tokens
    payreq = invoiceDetails.request
  } else if (opennode) {
    const data = await opennode.chargeInfo(invoiceId)
    amount = data.amount
    status = data.status
    payreq = data['lightning_invoice'].payreq
  } else {
    throw new Error(
      'No lightning node information configured on request object'
    )
  }

  return { status, amount, payreq }
}

/*
 * Validates a macaroon and should indicate reason for failure
 * if possible
 * @params {Macaroon} root - root macaroon
 * @params {Macaroon} discharge - discharge macaroon from 3rd party validation
 * @params {String} exactCaveat - a first party, exact caveat to test on root macaroon
 * @returns {Boolean|Exception} will return true if passed or throw with failure
 */
export function validateMacaroons(
  root: Macaroon,
  discharge: Macaroon,
  exactCaveat: FirstPartyCaveat
) {
  const TimestampCaveatVerifier = verifier.TimestampCaveatVerifier
  root = MacaroonsBuilder.deserialize(root)
  discharge = MacaroonsBuilder.deserialize(discharge)

  const boundMacaroon = MacaroonsBuilder.modify(root)
    .prepare_for_request(discharge)
    .getMacaroon()

  const { SESSION_SECRET } = getEnvVars()
  // lets verify the macaroon caveats
  const valid = new MacaroonsVerifier(root)
    // root macaroon should have a caveat to match the docId
    .satisfyExact(exactCaveat.caveat)
    // discharge macaroon is expected to have the time caveat
    .satisfyGeneral(TimestampCaveatVerifier)
    // confirm that the payment node has discharged appropriately
    .satisfy3rdParty(boundMacaroon)
    // confirm that this macaroon is valid
    .isValid(SESSION_SECRET)

  // if it's valid then we're good to go
  if (valid) return true

  // if not valid, let's check if it's because of time or because of docId mismatch
  const TIME_CAVEAT_PREFIX = /time < .*/

  // find time caveat in third party macaroon and check if time has expired
  for (let caveat of boundMacaroon.caveatPackets) {
    caveat = caveat.getValueAsText()
    if (TIME_CAVEAT_PREFIX.test(caveat) && !TimestampCaveatVerifier(caveat))
      throw new Error(`Time has expired for accessing content`)
  }

  for (let rawCaveat of root.caveatPackets) {
    const caveat = rawCaveat.getValueAsText()
    // TODO: should probably generalize the exact caveat check or export as constant.
    // This would fail even if there is a space missing in the caveat creation
    if (exactCaveat.prefixMatch(caveat) && caveat !== exactCaveat.caveat) {
      throw new Error(`${exactCaveat.key} did not match with macaroon`)
    }
  }
}

/*
 * Returns serealized discharge macaroon, signed with the server's caveat key
 * and with an attached caveat (if passed)
 * @params {Express.request} - req object
 * @params {String} caveat - first party caveat such as `time < ${now + 1000 seconds}`
 * @returns {Macaroon} discharge macaroon
 */
export function getDischargeMacaroon(
  invoiceId: string,
  location: string,
  caveat: string
) {
  if (!invoiceId) throw new Error('Missing invoiceId in request')

  const { CAVEAT_KEY } = getEnvVars()

  // check if there is a caveat key before proceeding
  if (!CAVEAT_KEY)
    throw new Error(
      'Service is missing caveat key for signing discharge macaroon. Contact node admin.'
    )

  // create discharge macaroon

  // Now that we've confirmed invoice is paid, create the discharge macaroon
  let macaroon = new MacaroonsBuilder(
    location,
    CAVEAT_KEY, // this should be randomly generated, w/ enough entropy and of length > 32 bytes
    invoiceId
  )

  if (caveat) macaroon.add_first_party_caveat(caveat)

  macaroon = macaroon.getMacaroon()

  return macaroon.serialize()
}

/*
 * Utility to extract first party caveat value from a serialized root macaroon
 * See `getFirstPartyCaveat` for what this value represents
 */
export function getFirstPartyCaveatFromMacaroon(serialized: string) {
  let macaroon = MacaroonsBuilder.deserialize(serialized)
  const firstPartyCaveat = getFirstPartyCaveat()
  for (let caveat of macaroon.caveatPackets) {
    caveat = caveat.getValueAsText()
    // find the caveat where the prefix matches our root caveat
    if (firstPartyCaveat.prefixMatch(caveat)) {
      // split on the separator, which should be an equals sign
      const [, value] = caveat.split(firstPartyCaveat.separator)
      // return value of the first party caveat (e.g. invoice id)
      return value.trim()
    }
  }
}

/*
 * Utility function to get a location string to describe _where_ the server is.
 * useful for setting identifiers in macaroons
 * @params {Express.request} req - expressjs request object
 * @params {Express.request.headers} [headers] - optional headers property added by zeit's now
 * @params {Express.request.hostname} - fallback if not in a now lambda
 * @returns {String} - location string
 */
export function getLocation({ headers, hostname }: LndRequest) {
  return headers
    ? headers['x-forwarded-proto'] + '://' + headers['x-now-deployment-url']
    : hostname || 'self'
}

// returns a set of mostly constants that describes the first party caveat
// this is set on a root macaroon. Supports an empty invoiceId
// since we can use this for matching the prefix on a populated macaroon caveat
export function getFirstPartyCaveat(invoiceId = ''): FirstPartyCaveat {
  return {
    key: 'invoiceId',
    value: invoiceId,
    separator: '=',
    caveat: `invoiceId = ${invoiceId}`,
    prefixMatch: (value: string) => /invoiceId = .*/.test(value),
  }
}

type prefixMatchFn = (value: string) => boolean
interface FirstPartyCaveat {
  key: string
  value?: string
  separator: string
  caveat: string
  prefixMatch: prefixMatchFn
}
