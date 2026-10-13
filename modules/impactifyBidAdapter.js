'use strict';
import { deepAccess, deepSetValue, getWinDimensions, isPlainObject, getWindowTop } from '../src/utils.js';
import { registerBidder } from '../src/adapters/bidderFactory.js';
import { noCredsAjax as ajax } from '../src/ajax.js';
import { getStorageManager } from '../src/storageManager.js';
import { isViewabilityMeasurable, getViewability } from '../libraries/percentInView/percentInView.js';
import { ortbConverter } from '../libraries/ortbConverter/converter.js';

/**
 * @typedef {import('./impactifyBidAdapter.d.ts').ImpactifyBidderParams} ImpactifyBidderParams
 * @typedef {import('../src/adapterManager.js').BidRequest<'impactify'>} BidRequest
 * @typedef {import('../src/bidfactory.js').BidResponse} BidResponse
 * @typedef {import('../src/adapters/bidderFactory.js').BidderSpec<'impactify'>} BidderSpec
 * @typedef {import('../src/adapters/bidderFactory.js').ServerResponse} ServerResponse
 * @typedef {Parameters<NonNullable<BidderSpec['getUserSyncs']>>[0]} SyncOptions
 * @typedef {import('../src/userSync.js').UserSync} UserSync
 */

const BIDDER_CODE = 'impactify';
const BIDDER_ALIAS = ['imp'];
const DEFAULT_CURRENCY = 'USD';
const DEFAULT_VIDEO_WIDTH = 640;
const DEFAULT_VIDEO_HEIGHT = 360;
const ORIGIN = 'https://sonic.impactify.media';
const LOGGER_URI = 'https://logger.impactify.media';
const AUCTION_URI = '/bidder';
const COOKIE_SYNC_URI = '/static/cookie_sync.html';
const GVL_ID = 606;
export const STORAGE = getStorageManager({ gvlid: GVL_ID, bidderCode: BIDDER_CODE });
export const STORAGE_KEY = '_im_str';
const VIDEO_PARAMS = [
  'minduration',
  'maxduration',
  'api',
  'mimes',
  'placement',
  'plcmt',
  'protocols',
  'playbackmethod',
  'pos',
  'startdelay',
  'skip',
  'skipmin',
  'skipafter',
  'minbitrate',
  'maxbitrate'
];

/**
 * Helpers object
 * @type {Object}
 */
const helpers = {
  getExtParamsFromBid(bid) {
    const ext = {
      impactify: {
        appId: bid.params.appId
      },
    };
    const render = {};

    if (typeof bid.params.format === 'string') {
      ext.impactify.format = bid.params.format;
    }

    if (typeof bid.params.style === 'string') {
      ext.impactify.style = bid.params.style;
    }

    if (typeof bid.params.size === 'string') {
      ext.impactify.size = bid.params.size;
    }

    const viewability = this.getViewability(bid);
    ext.impactify.viewability = viewability;

    if (isPlainObject(bid.params.render)) {
      if (typeof bid.params.render.top === 'number') {
        render.top = bid.params.render.top;
      }

      if (typeof bid.params.render.bottom === 'number') {
        render.bottom = bid.params.render.bottom;
      }

      if (typeof bid.params.render.align === 'string') {
        render.align = bid.params.render.align;
      }

      if (typeof bid.params.render.container === 'string') {
        render.container = bid.params.render.container;
      }

      if (typeof bid.params.render.expandAd === 'boolean') {
        render.expandAd = bid.params.render.expandAd;
      }

      if (typeof bid.params.render.location === 'string') {
        render.location = bid.params.render.location;
      }

      if (typeof bid.params.render.onAdEventName === 'string') {
        render.onAdEventName = bid.params.render.onAdEventName;
      }

      if (typeof bid.params.render.onNoAdEventName === 'string') {
        render.onNoAdEventName = bid.params.render.onNoAdEventName;
      }

      if (Object.keys(render).length > 0) {
        ext.impactify.render = render;
      }
    }

    return ext;
  },

  pickDefined(obj, keys) {
    return keys.reduce((acc, key) => {
      if (obj[key] !== undefined) {
        acc[key] = obj[key];
      }
      return acc;
    }, {});
  },

  getViewability(bid) {
    try {
      let elementSize;
      if (bid.mediaTypes?.banner?.sizes?.[0]) {
        elementSize = bid.mediaTypes?.banner?.sizes?.[0];
      }
      if (bid.mediaTypes?.video?.playerSize?.[0]) {
        elementSize = bid.mediaTypes?.video?.playerSize?.[0];
      }
      if (!elementSize) { elementSize = [0, 0]; }

      const size = { w: elementSize[0], h: elementSize[1] };
      const element = document.getElementById(bid.adUnitCode);

      if (!element) return;

      const viewabilityAmount = isViewabilityMeasurable(element)
        ? getViewability(element, getWindowTop(), size)
        : 'na';

      return isNaN(viewabilityAmount) ? viewabilityAmount : Math.round(viewabilityAmount);
    } catch (e) {
      return 'na';
    }
  },

  getDeviceType(userAgent = '') {
    // OpenRTB Device type
    if ((/ipad|android 3.0|xoom|sch-i800|playbook|tablet|kindle/i.test(userAgent))) {
      return 5;
    }
    if ((/iphone|ipod|android|blackberry|opera|mini|windows\sce|palm|smartphone|iemobile/i.test(userAgent))) {
      return 4;
    }
    return 2;
  },

  createOrtbImpBannerObj(bid, bannerObj) {
    const format = [];
    const sizes = bannerObj?.sizes;

    if (Array.isArray(sizes)) {
      sizes.forEach((size) => {
        if (Array.isArray(size) && size.length >= 2) {
          format.push({ w: size[0], h: size[1] });
        }
      });
    }

    return {
      id: 'banner-' + (bid?.bidId || ''),
      format
    };
  },

  createOrtbImpVideoObj(bid) {
    const video = deepAccess(bid, 'mediaTypes.video');
    if (!video) return;

    const playerSize = Array.isArray(video.playerSize?.[0])
      ? video.playerSize[0]
      : video.playerSize || bid.sizes?.[0];
    const resolvedPlayerSize = playerSize && playerSize.length === 2
      ? playerSize
      : [DEFAULT_VIDEO_WIDTH, DEFAULT_VIDEO_HEIGHT];

    return {
      playerSize: resolvedPlayerSize,
      context: video.context === 'instream' ? 'instream' : 'outstream',
      ...helpers.pickDefined(video, VIDEO_PARAMS)
    };
  },

  getFloor(bid) {
    try {
      const floorInfo = bid.getFloor({
        currency: DEFAULT_CURRENCY,
        mediaType: '*',
        size: '*'
      });
      if (isPlainObject(floorInfo) && floorInfo.currency === DEFAULT_CURRENCY && !isNaN(parseFloat(floorInfo.floor))) {
        return parseFloat(floorInfo.floor);
      }
    } catch (e) {}
    return null;
  },

  getImStrFromLocalStorage() {
    return STORAGE.localStorageIsEnabled(false) ? STORAGE.getDataFromLocalStorage(STORAGE_KEY, false) : '';
  }

};

const converter = ortbConverter({
  // Keep Impactify's impression format and floor lookup independent of optional processors.
  imp(buildImp, bid) {
    const bannerObj = deepAccess(bid.mediaTypes, `banner`);
    const videoObj = deepAccess(bid.mediaTypes, `video`);

    const imp = {
      id: bid.bidId,
      bidfloor: bid.params.bidfloor ? bid.params.bidfloor : 0,
      ext: helpers.getExtParamsFromBid(bid)
    };

    if (bannerObj) {
      imp.banner = {
        ...helpers.createOrtbImpBannerObj(bid, bannerObj)
      };
    }

    if (videoObj) {
      imp.video = {
        ...helpers.createOrtbImpVideoObj(bid)
      };
    }

    if (typeof bid.getFloor === 'function') {
      const floor = helpers.getFloor(bid);
      if (floor !== null) {
        imp.bidfloor = floor;
      }
    }

    return imp;
  },
  request(buildRequest, imps, bidderRequest, context) {
    // Core enrichment and activity controls have already populated and filtered ortb2.
    const request = buildRequest(imps, bidderRequest, context);
    const validBidRequests = context.bidRequests;
    Object.assign(request, {
      id: bidderRequest.bidderRequestId,
      validBidRequests,
      cur: [DEFAULT_CURRENCY],
      tmax: Math.max(bidderRequest.timeout || 400, 400)
    });
    deepSetValue(request, 'ext.impactify.integration', 'pbjs');
    deepSetValue(request, 'ext.impactify.storage', helpers.getImStrFromLocalStorage());

    const checkPrebid = new URLSearchParams(window?.location?.search).get('_checkPrebid');
    if (checkPrebid != null) {
      request.test = Number(checkPrebid);
    }

    // Keep canonical values when filling adapter-specific defaults.
    const setDefault = (path, value) => {
      if (value !== undefined && deepAccess(request, path) === undefined) {
        deepSetValue(request, path, value);
      }
    };
    setDefault('source', {});
    setDefault('source.ext.schain', deepAccess(validBidRequests, '0.ortb2.source.ext.schain'));
    const eids = deepAccess(validBidRequests, '0.userIdAsEids');
    if (eids?.length) {
      setDefault('user.ext.eids', eids);
    }

    setDefault('device.w', getWinDimensions().innerWidth);
    setDefault('device.h', getWinDimensions().innerHeight);
    setDefault('device.devicetype', helpers.getDeviceType(request.device?.ua));
    setDefault('device.js', 1);
    setDefault('device.language', 'en');
    if (!request.app && !request.dooh) {
      setDefault('site.page', bidderRequest.refererInfo?.page);
      setDefault('site.publisher.id', validBidRequests[0]?.params.accountId);
    }
    return request;
  }
});

/**
 * Export BidderSpec type object and register it to Prebid
 * @type {BidderSpec & {storageAllowed: boolean}}
 */
export const spec = {
  code: BIDDER_CODE,
  gvlid: GVL_ID,
  supportedMediaTypes: ['video', 'banner'],
  aliases: BIDDER_ALIAS,
  storageAllowed: true,

  /**
   * Determines whether or not the given bid request is valid.
   *
   * @param {BidRequest} bid The bid params to validate.
   * @return boolean True if this is a valid bid, and false otherwise.
   */
  isBidRequestValid: function (bid) {
    if (typeof bid.params.style !== 'string' || !bid.params.style) {
      return false;
    }

    return true;
  },

  /**
   * Make a server request from the list of BidRequests.
   *
   * @param {Array} validBidRequests - an array of bids
   * @param {Object} bidderRequest - the bidding request
   * @return {Object} Info describing the request to the server.
   */
  buildRequests: function (validBidRequests, bidderRequest) {
    const request = converter.toORTB({ bidRequests: validBidRequests, bidderRequest: bidderRequest ?? {} });
    const options = {};

    return {
      method: 'POST',
      url: ORIGIN + AUCTION_URI,
      data: JSON.stringify(request),
      options
    };
  },

  /**
   * Unpack the response from the server into a list of bids.
   *
   * @param {ServerResponse} serverResponse A successful response from the server.
   * @return {BidResponse[]} An array of bids which were nested inside the server.
   */
  interpretResponse: function (serverResponse, bidRequest) {
    const serverBody = serverResponse.body;
    let bidResponses = [];

    if (!serverBody) {
      return bidResponses;
    }

    if (!serverBody.seatbid || !serverBody.seatbid.length) {
      return [];
    }

    let ortbRequest = {};
    try {
      ortbRequest = JSON.parse(bidRequest?.data || '{}');
    } catch (e) { }

    const impMap = {};
    (ortbRequest.imp || []).forEach((imp) => {
      impMap[imp.id] = imp;
    });

    serverBody.seatbid.forEach((seatbid) => {
      if (seatbid?.bid?.length) {
        bidResponses.push(
          ...seatbid.bid
            .filter((bid) => bid.price > 0)
            .map((bid) => {
              const isPlayer = impMap[bid.impid]?.ext?.impactify?.format === 'player';
              const isVideo = !!impMap[bid.impid]?.video;
              let mediaType;
              if (bid?.mtype === 2) {
                mediaType = 'video';
              } else if (bid?.mtype === 1) {
                mediaType = 'banner';
              } else if (isPlayer || isVideo) {
                mediaType = 'video';
              } else {
                mediaType = 'banner';
              }

              return {
                id: bid.id,
                requestId: bid.impid,
                cpm: bid.price,
                currency: serverBody.cur || DEFAULT_CURRENCY,
                netRevenue: true,
                width: bid.w || 0,
                height: bid.h || 0,
                ttl: 300,
                creativeId: bid.crid || 0,
                mediaType: mediaType,
                meta: {
                  advertiserDomains:
                    bid.adomain && bid.adomain.length ? bid.adomain : [],
                },

                ...(isPlayer
                  ? {
                      vastUrl: bid.ext?.vast_url,
                      vastXml: bid.adm,
                    }
                  : {
                      ad: bid.adm,
                    }),
              };
            }),
        );
      }
    });

    return bidResponses;
  },

  /**
   * Register the user sync pixels which should be dropped after the auction.
   *
   * @param {SyncOptions} syncOptions Which user syncs are allowed?
   * @param {ServerResponse[]} serverResponses List of server's responses.
   * @param {import('../src/types/consent/tcf.d.ts').TCFConsentData | null} gdprConsent
   * @param {string | null} uspConsent
   * @param {import('../src/types/consent/gpp.d.ts').GPPConsentData | null} gppConsent
   * @param {boolean} coppa Whether COPPA applies.
   * @return {UserSync[]} The user syncs which should be dropped.
   */
  getUserSyncs: function (
    syncOptions,
    serverResponses,
    gdprConsent,
    uspConsent,
    gppConsent,
    coppa
  ) {
    if (!serverResponses || serverResponses.length === 0) {
      return [];
    }

    if (!syncOptions.iframeEnabled || coppa === true) {
      return [];
    }

    const params = new URLSearchParams();
    if (typeof gdprConsent?.gdprApplies === 'boolean') {
      params.set('gdpr', String(Number(gdprConsent.gdprApplies)));
    }
    if (typeof gdprConsent?.consentString === 'string') {
      params.set('gdpr_consent', gdprConsent.consentString);
    }

    if (typeof uspConsent === 'string') {
      params.set('us_privacy', uspConsent);
    }
    if (typeof gppConsent?.gppString === 'string') {
      params.set('gpp', gppConsent.gppString);
    }
    if (Array.isArray(gppConsent?.applicableSections)) {
      params.set('gpp_sid', gppConsent.applicableSections.join(','));
    }
    if (document?.location?.search?.match(/pbs_debug=true/)) params.set('pbs_debug', 'true');
    const query = params.toString();

    return [{
      type: 'iframe',
      url: ORIGIN + COOKIE_SYNC_URI + (query ? `?${query}` : '')
    }];
  },

  /**
   * Register bidder specific code, which will execute if a bid from this bidder won the auction
   * @param {Object} bid The bid that won the auction
   */
  onBidWon: function (bid) {
    ajax(`${LOGGER_URI}/prebid/won`, null, JSON.stringify(bid), {
      method: 'POST',
      contentType: 'application/json'
    });

    return true;
  },

  /**
   * Register bidder specific code, which will execute if bidder timed out after an auction
   * @param {Object} data Containing timeout specific data
   */
  onTimeout: function (data) {
    ajax(`${LOGGER_URI}/prebid/timeout`, null, JSON.stringify(data[0]), {
      method: 'POST',
      contentType: 'application/json'
    });

    return true;
  },
};
registerBidder(spec);
