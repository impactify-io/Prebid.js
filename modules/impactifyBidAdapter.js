'use strict';

import { deepAccess, deepSetValue, getWindowLocation, isPlainObject, parseQS } from '../src/utils.js';
import { registerBidder } from '../src/adapters/bidderFactory.js';
import { ajax } from '../src/ajax.js';
import { ortbConverter } from '../libraries/ortbConverter/converter.js';

/**
 * @typedef {import('../src/adapters/bidderFactory.js').BidRequest} BidRequest
 * @typedef {import('../src/adapters/bidderFactory.js').Bid} Bid
 * @typedef {import('../src/adapters/bidderFactory.js').ServerResponse} ServerResponse
 * @typedef {import('../src/adapters/bidderFactory.js').SyncOptions} SyncOptions
 * @typedef {import('../src/adapters/bidderFactory.js').UserSync} UserSync
 */

const BIDDER_CODE = 'impactify';
const BIDDER_ALIAS = ['imp'];

const ORIGIN = 'https://sonic.impactify.media';
const LOGGER_URI = 'https://logger.impactify.media';
const AUCTION_URI = '/bidder';
const COOKIE_SYNC_URI = '/static/cookie_sync.html';

const DEFAULT_CURRENCY = 'USD';
const DEFAULT_VIDEO_PLAYER_SIZE = [640, 360];
const GVL_ID = 606;

function getBidderParams(bid) {
  const bidderParams = {
    appId: bid.params.appId,
    format: bid.params.format,
    style: bid.params.style,
  };

  if (typeof bid.params.container === 'string') bidderParams.container = bid.params.container;
  if (typeof bid.params.size === 'string') bidderParams.size = bid.params.size;
  if (typeof bid.params.publisherId === 'string') bidderParams.publisherId = bid.params.publisherId;

  return bidderParams;
}

/**
 * Optional backward-compat helpers so publishers can keep using legacy params
 * while you migrate them toward standard Prebid mediaTypes shapes.
 */
function normalizeMediaTypes(bid) {
  // Banner: if publishers only pass params.size like "300x250".
  if (!deepAccess(bid, 'mediaTypes.banner.sizes') && typeof bid.params.size === 'string') {
    const sizeMatch = bid.params.size.match(/^(\d+)x(\d+)$/);
    if (sizeMatch) deepSetValue(bid, 'mediaTypes.banner.sizes', [[Number(sizeMatch[1]), Number(sizeMatch[2])]]);
  }

  // Video: ensure playerSize exists (ORTB video needs dimensions).
  const playerSize = deepAccess(bid, 'mediaTypes.video.playerSize') || bid.sizes?.[0];
  if (deepAccess(bid, 'mediaTypes.video') && (!Array.isArray(playerSize) || playerSize.length !== 2)) {
    deepSetValue(bid, 'mediaTypes.video.playerSize', DEFAULT_VIDEO_PLAYER_SIZE);
  }
}

/**
 * ORTB converter wiring:
 * - Let Prebid modules populate ortb2 (FPD, consent, schain, userId/eids, floors, etc.)
 * - Only add Impactify-specific bidder params (as PBS extensions)
 */
const converter = ortbConverter({
  // These are the only bidResponse defaults you used before.
  context: {
    netRevenue: true,
    ttl: 300,
  },

  imp(buildImp, bidRequest, context) {
    // Keep the request predictable even if a publisher is still using legacy params.
    normalizeMediaTypes(bidRequest);

    const imp = buildImp(bidRequest, context);

    // Prebid Server bidder params location (recommended): imp.ext.prebid.bidder.<BIDDER>
    // https://docs.prebid.org/faq/prebid-server-faq.html#did-the-location-of-the-bidder-parameters-change
    deepSetValue(imp, `ext.prebid.bidder.${BIDDER_CODE}`, getBidderParams(bidRequest));

    // Preserve your legacy override if params.bidfloor was used.
    if (!isNaN(parseFloat(bidRequest.params?.bidfloor)) && imp.bidfloor == null) {
      imp.bidfloor = parseFloat(bidRequest.params.bidfloor);
      imp.bidfloorcur = DEFAULT_CURRENCY;
    }

    return imp;
  },

  request(buildRequest, imps, bidderRequest, context) {
    const ortbRequest = buildRequest(imps, bidderRequest, context);

    // Keep previous behavior: always send a currency if none was provided by modules.
    if (!Array.isArray(ortbRequest.cur) || ortbRequest.cur.length === 0) {
      ortbRequest.cur = [DEFAULT_CURRENCY];
    }

    // Your backend currently supports test-mode via _checkPrebid
    const { search } = getWindowLocation();
    const query = parseQS(search);
    const checkPrebid = query._checkPrebid;
    if (checkPrebid != null) ortbRequest.test = Number(checkPrebid);

    // If ortb2 provided a global tid, keep passing it (PBS-friendly field).
    const tid = bidderRequest?.ortb2?.source?.tid;
    if (tid) deepSetValue(ortbRequest, 'source.tid', tid);

    return ortbRequest;
  },

  bidResponse(buildBidResponse, bid, context) {
    const bidResponse = buildBidResponse(bid, context);

    // Keep your non-standard fields if the server returns them.
    if (bid && isPlainObject(bid)) {
      if (bid.hash != null) bidResponse.hash = bid.hash;
      if (bid.expiry != null) bidResponse.expiry = bid.expiry;
    }

    return bidResponse;
  },
});

export const spec = {
  code: BIDDER_CODE,
  gvlid: GVL_ID,
  supportedMediaTypes: ['video', 'banner'],
  aliases: BIDDER_ALIAS,

  /**
   * @param {BidRequest} bid
   * @return {boolean}
   */
  isBidRequestValid(bid) {
    if (typeof bid.params.appId !== 'string' || !bid.params.appId) return false;
    if (typeof bid.params.format !== 'string' || !bid.params.format) return false;
    if (typeof bid.params.style !== 'string' || !bid.params.style) return false;

    if (bid.params.format !== 'screen' && bid.params.format !== 'display') return false;
    if (bid.params.style !== 'inline' && bid.params.style !== 'impact' && bid.params.style !== 'static') return false;

    return true;
  },

  /**
   * @param {BidRequest[]} validBidRequests
   * @param {Object} bidderRequest
   */
  buildRequests(validBidRequests, bidderRequest) {
    const ortbRequest = converter.toORTB({
      bidderRequest,
      bidRequests: validBidRequests,
    });

    return {
      method: 'POST',
      url: ORIGIN + AUCTION_URI,
      data: JSON.stringify(ortbRequest),
      options: {
        contentType: 'application/json',
      },
      ortbRequest,
    };
  },

  /**
   * @param {ServerResponse} serverResponse
   * @param {*} bidRequest
   * @return {Bid[]}
   */
  interpretResponse(serverResponse, bidRequest) {
    const ortbResponse = serverResponse?.body;
    if (!ortbResponse) return [];

    // Converter requires the exact same request object returned by toORTB.
    const ortbRequest = bidRequest?.ortbRequest;
    if (!ortbRequest) return [];

    return converter.fromORTB({ request: ortbRequest, response: ortbResponse }).bids || [];
  },

  /**
   * @param {SyncOptions} syncOptions
   * @param {ServerResponse[]} serverResponses
   * @return {UserSync[]}
   */
  getUserSyncs(syncOptions, serverResponses, gdprConsent, uspConsent) {
    if (!serverResponses || serverResponses.length === 0) return [];
    if (!syncOptions.iframeEnabled) return [];

    let params = '';
    if (gdprConsent && typeof gdprConsent.consentString === 'string') {
      if (typeof gdprConsent.gdprApplies === 'boolean') {
        params += `?gdpr=${Number(gdprConsent.gdprApplies)}&gdpr_consent=${gdprConsent.consentString}`;
      } else {
        params += `?gdpr_consent=${gdprConsent.consentString}`;
      }
    }

    if (uspConsent) {
      params += `${params ? '&' : '?'}us_privacy=${encodeURIComponent(uspConsent)}`;
    }

    const { search } = getWindowLocation();
    if (parseQS(search).pbs_debug === 'true') params += `${params ? '&' : '?'}pbs_debug=true`;

    return [{
      type: 'iframe',
      url: ORIGIN + COOKIE_SYNC_URI + params,
    }];
  },

  onBidWon(bid) {
    ajax(`${LOGGER_URI}/prebid/won`, null, JSON.stringify(bid), {
      method: 'POST',
      contentType: 'application/json',
    });
    return true;
  },

  onTimeout(data) {
    ajax(`${LOGGER_URI}/prebid/timeout`, null, JSON.stringify(data?.[0]), {
      method: 'POST',
      contentType: 'application/json',
    });
    return true;
  },
};

registerBidder(spec);
