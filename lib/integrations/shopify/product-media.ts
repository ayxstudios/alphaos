import { ShopifyClient } from "./client";
import type { ShopifyCredentials } from "./types";

type ProductMediaNode = {
  sku: string | null;
  title: string | null;
  variantTitle: string | null;
  product: {
    title: string | null;
    handle: string | null;
    onlineStoreUrl: string | null;
    featuredImage: { url: string; altText: string | null } | null;
  } | null;
  variant: {
    title: string | null;
    image: { url: string; altText: string | null } | null;
  } | null;
};

type ProductMediaResponse = {
  order: {
    lineItems: {
      nodes: ProductMediaNode[];
    };
  } | null;
};

export type ShopifyProductMedia = {
  sku: string | null;
  title: string | null;
  variantTitle: string | null;
  imageUrl: string | null;
  imageAlt: string | null;
  productUrl: string | null;
};

const PRODUCT_MEDIA_QUERY = `
query($id: ID!) {
  order(id: $id) {
    lineItems(first: 50) {
      nodes {
        sku
        title
        variantTitle
        product {
          title
          handle
          onlineStoreUrl
          featuredImage { url altText }
        }
        variant {
          title
          image { url altText }
        }
      }
    }
  }
}`;

function fallbackProductUrl(shopDomain: string | undefined, handle: string | null | undefined): string | null {
  if (!shopDomain || !handle) return null;
  return `https://${shopDomain}/products/${handle}`;
}

export async function fetchShopifyOrderProductMedia(
  shopId: string,
  platformOrderId: string,
  creds: ShopifyCredentials,
): Promise<ShopifyProductMedia[]> {
  const client = new ShopifyClient(shopId, creds);
  const data = await client.graphql<ProductMediaResponse>(PRODUCT_MEDIA_QUERY, {
    id: `gid://shopify/Order/${platformOrderId}`,
  });

  return (data.order?.lineItems.nodes ?? []).map((line) => {
    const image = line.variant?.image ?? line.product?.featuredImage ?? null;
    return {
      sku: line.sku,
      title: line.title ?? line.product?.title ?? null,
      variantTitle: line.variantTitle ?? line.variant?.title ?? null,
      imageUrl: image?.url ?? null,
      imageAlt: image?.altText ?? line.title ?? line.product?.title ?? null,
      productUrl: line.product?.onlineStoreUrl ?? fallbackProductUrl(creds.shopDomain, line.product?.handle),
    };
  });
}
