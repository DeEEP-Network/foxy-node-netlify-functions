import FoxyWebhook from "../../foxy/FoxyWebhook.js";
import { WebflowClient } from "webflow-api";
import { config } from "../../../config.js";

const webflow = new WebflowClient({ accessToken: config.datastore.provider.webflow.token });

function customOptions() {
  return {
    fields: {
      code: config.datastore.field.code || 'code',
      inventory: config.datastore.field.inventory || 'inventory',
      price: config.datastore.field.price || 'price',
    },
    skip: {
      inventory: (config.datastore.skipValidation.inventory || '').split(',').map(e => e.trim()).filter(e => !!e) || [],
      price: (config.datastore.skipValidation.price || '').split(',').map(e => e.trim()).filter(e => !!e) || [],
      updateinfo: config.datastore.skipValidation.updateinfo || 'Update Your Customer Information',
    },
    webflow: {
      limit: 100,
    },
  }
}

/**
 * Validation checks
 */
const validation = {
  configuration: {
    response: () => ({
      body: JSON.stringify({ details: 'Webflow token not configured.', ok: false }),
      statusCode: 503,
    }),
    validate: () => !!config.datastore.provider.webflow.token,
  },
  input: {
    errorMessage: "",
    response: function() {
      return {
        body: JSON.stringify({ details: this.errorMessage, ok: false }),
        statusCode: 400,
      }
    },
    validate: function (requestEvent) {
      this.errorMessage = FoxyWebhook.validFoxyRequest(requestEvent);
      return !this.errorMessage;
    }
  },
  items: {
    response: (items) => ({
      body: JSON.stringify({
        details: `Invalid items: ${items.filter(e => !validItem(e)).map((e) => e.name).join(',')}`,
        ok: false,
      }),
      statusCode: 200,
    }),
    validate: (items) => items.every(e => validItem(e)),
  }
}


async function handler(requestEvent) {
  // Validation
  if (!validation.configuration.validate()) {
    return validation.configuration.response();
  }
  if (!validation.input.validate(requestEvent)) {
    return validation.input.response();
  }
  let items = extractItems(requestEvent.body);
  if (!validation.items.validate(items)) {
    return validation.items.response(items);
  }

  try {
    let failed = false;
    for (const item of items) {
      const enrichedItem = await fetchItem(item);
      // all or nothing, if an item fails the cart fails
      failed = !isPriceCorrect(enrichedItem) || !sufficientInventory(enrichedItem);
      if (failed) break;
    };

    if (failed) {
      return {
        body: JSON.stringify({ details: "Item(s) in cart failed validation", ok: false }),
        statusCode: 200,
      };
    } else {
      console.log('OK: payment approved - no mismatch found')
      return {
        body: JSON.stringify({ details: '', ok: true }),
        statusCode: 200,
      };
    }
  } catch (e) {
    console.error(e);
    return {
      body: JSON.stringify({ details: "An internal error has occurred", ok: false }),
      statusCode: 500,
    };
  }
}

function getCustomKey(default_key) {
  const options = customOptions();
  const keys = Object.keys(options.fields);
  return keys.find((key) => key === default_key) || default_key;
}

function getOption(item, option) {
  if (Object.hasOwn(item, option)) return { name: option, value: item[option] };
  if (item._embedded && item._embedded['fx:item_options']) {
    found = item._embedded['fx:item_options'].find((e) => e.name.toLowerCase().trim() === option.toLowerCase().trim());
    if (found) return found;
  }
  console.warn(`Warning: (${option}) does not exist in this webflow collection`);
  console.warn(`Available fields: `, Object.keys(item));
  return {};
}

function getCustomOption(item, option) {
  const custom_option = getCustomKey(option);
  return getOption(item, custom_option).value || null;
}

function extractItems(body) {
  const objBody = JSON.parse(body);
  if (objBody && objBody._embedded && objBody._embedded['fx:items']) {
    return objBody._embedded['fx:items'].filter(item => item.name !== customOptions().skip.updateinfo);
  }
  return [];
}

function validItem(item) {
  const errors = [];
  if (!(item.price || parseInt(item.price, 10) === 0)) {
    errors.push(`${item.name} has no price.`)
  }
  if (!(item.quantity || parseInt(item.quantity, 10) === 0)) {
    errors.push(`${item.name} has no quantity.`)
  }
  if (!(item.code || parseInt(item.code, 10) === 0)) {
    errors.push(`${item.name} has no code.`)
  }
  if (errors.length) {
    console.log("Invalid item ", item.name, errors.join(' '));
    return false;
  }
  return true;
}

function isPriceCorrect(enrichedItem) {
  const { wfItem, fxItem } = enrichedItem;
  if (!wfItem || !fxItem) return new Error("Need both items to compare");
  if (customOptions().skip.price.includes(wfItem.id)) return true; // skip validation
  
  const wfPrice = parseFloat(getCustomOption(wfItem.fieldData, 'foxyprice'));
  const fxPrice = parseFloat(fxItem.price);
  console.log('isPriceCorrect: ', wfPrice, fxPrice);
  return fxPrice === wfPrice;
}

function sufficientInventory(enrichedItem) {
  const { wfItem, fxItem } = enrichedItem;
  if (!wfItem || !fxItem) return new Error("Need both items to compare");
  if (customOptions().skip.price.includes(wfItem.id)) return true; // skip validation

  try {
    const fxQuantity = Number(getCustomOption(fxItem, 'quantity'));
    const wfInventory = Number(getCustomOption(wfItem.fieldData, 'foxyinventory'));
    console.log('sufficientInventory: ', fxQuantity, wfInventory);
    return wfInventory >= fxQuantity;
  } catch (e) {
    console.log('sufficientInventory: ', e);
    return true;
  }
}

function getSiteId() {
  const id = config.datastore.provider.webflow.site;
  if (!id) {
    console.warn("Don't forget to set `FOXY_WEBFLOW_SITE` env variable");
    console.log(config.datastore.provider.webflow);
  }
  return id || '6676e3fa22cb2a860ec4ef00';
}

function getProductId(item) {
  const id = getOption(item, 'code').value || config.datastore.provider.webflow.product;
  if (!id) {
    console.warn("'code' isn't sent or `FOXY_WEBFLOW_PRODUCT` env variable isn't set");
    console.log(config.datastore.provider.webflow);
  }
  return id;
}

function enrichFetchedItem(webflowItem, foxyItem) {
  return {fxItem: foxyItem, wfItem: webflowItem};
}

async function fetchItem(foxyItem) {
  const siteId = getSiteId();
  const productId = getProductId(foxyItem);

  const { product } = await webflow.products.get(siteId, productId);
  if (product) {
    return enrichFetchedItem(product, foxyItem);
  } else {
    return new Error('Item not found');
  }
}

module.exports = {
  handler,
  extractItems,
  getCustomOption
}
