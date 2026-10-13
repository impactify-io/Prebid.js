export interface RenderParams {
  top?: number;
  bottom?: number;
  align?: string;
  container?: string;
  expandAd?: boolean;
  location?: string;
  onAdEventName?: string;
  onNoAdEventName?: string;
}

export interface ImpactifyBidderParams {
  /** Impactify ad style. */
  style: string;
  /** Impactify inventory identifier. */
  appId?: string;
  /** Impactify publisher identifier. */
  accountId?: string;
  format?: string;
  size?: string;
  bidfloor?: number;
  render?: RenderParams;
}

declare module '../src/adUnits' {
  interface BidderParams {
    impactify: ImpactifyBidderParams;
    imp: ImpactifyBidderParams;
  }
}
