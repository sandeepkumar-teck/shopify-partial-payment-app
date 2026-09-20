const PAGE_SIZE = 50;
const MAX_ORDERS = 250;
const HISTORY_DAYS = 183;

function identityFields(includeCustomer) {
  if (!includeCustomer) return "";
  return `
        customer { displayName firstName lastName }`;
}

function addressFields(includeAddresses) {
  if (!includeAddresses) return "";
  return `
        shippingAddress { name firstName lastName }
        billingAddress { name firstName lastName }`;
}

function cancelledAtField(includeCancelledAt) {
  if (!includeCancelledAt) return "";
  return `
        cancelledAt`;
}

function outstandingField(includeOutstanding) {
  if (!includeOutstanding) return "";
  return `
        totalOutstandingSet {
          shopMoney { amount currencyCode }
        }`;
}

function receivedField(includeReceived) {
  if (!includeReceived) return "";
  return `
        totalReceivedSet {
          shopMoney { amount currencyCode }
        }`;
}

function buildOrdersQuery({
  includeCustomer,
  includeAddresses,
  includeCancelledAt,
  includeOutstanding = true,
  includeReceived = true,
}) {
  return `#graphql
  query PartialPaymentDashboard($first: Int!, $after: String, $query: String) {
    shop {
      name
      myshopifyDomain
      currencyCode
    }
    orders(first: $first, after: $after, sortKey: CREATED_AT, reverse: true, query: $query) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        createdAt
        ${cancelledAtField(includeCancelledAt)}
        tags
        displayFinancialStatus
        currentTotalPriceSet {
          shopMoney { amount currencyCode }
        }
        ${outstandingField(includeOutstanding)}
        ${receivedField(includeReceived)}
        ${identityFields(includeCustomer)}
        ${addressFields(includeAddresses)}
        customAttributes { key value }
        metafield(namespace: "$app", key: "partial_payment") {
          value
        }
        lineItems(first: 50) {
          nodes {
            title
            image { url }
            product { id }
            customAttributes { key value }
          }
        }
      }
    }
  }
`;
}

function createdAtQuery(days = HISTORY_DAYS) {
  const start = new Date();
  start.setDate(start.getDate() - days);
  return `created_at:>='${start.toISOString().slice(0, 10)}'`;
}

/** Never iterate a non-array. Shopify sometimes gives a GraphqlQueryError wrapper. */
function asErrorList(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value !== "object") return [{ message: String(value) }];
  if (Array.isArray(value.graphQLErrors) && value.graphQLErrors.length) return value.graphQLErrors;
  if (value.graphQLErrors && typeof value.graphQLErrors === "object" && !Array.isArray(value.graphQLErrors)) {
    const nested = value.graphQLErrors;
    if (Array.isArray(nested.graphQLErrors) && nested.graphQLErrors.length) return nested.graphQLErrors;
    if (typeof nested.message === "string" && nested.message) return [nested];
  }
  if (Array.isArray(value.errors) && value.errors.length) return value.errors;
  if (typeof value.message === "string" && value.message) return [value];
  return [];
}

function graphQlProblems(json) {
  try {
    const problems = [];
    const seen = new Set();
    const push = (item) => {
      const message =
        item == null
          ? ""
          : typeof item === "string"
            ? item
            : item.message || "";
      if (!message || seen.has(message)) return;
      seen.add(message);
      problems.push(message);
    };

    const payload = json && typeof json === "object" ? json : {};
    for (const candidate of [
      payload.errors,
      payload.graphQLErrors,
      payload.body?.errors,
      payload.body?.graphQLErrors,
    ]) {
      for (const item of asErrorList(candidate)) push(item);
    }

    const data = payload.data ?? payload.body?.data;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      for (const value of Object.values(data)) {
        const userErrors = Array.isArray(value?.userErrors) ? value.userErrors : [];
        for (const error of userErrors) push(error);
      }
    }
    return problems;
  } catch {
    return [];
  }
}

function shortGraphQlErrorLog(error) {
  const bodyErrors = error?.body?.errors;
  const graphQLErrors =
    error?.graphQLErrors ||
    (Array.isArray(bodyErrors) ? bodyErrors : bodyErrors?.graphQLErrors);
  if (Array.isArray(graphQLErrors) && graphQLErrors.length) {
    return graphQLErrors
      .map((item) => item?.message || String(item))
      .filter(Boolean)
      .join("; ");
  }
  if (typeof bodyErrors === "string" && bodyErrors) return bodyErrors;
  if (typeof error?.message === "string" && error.message) return error.message;
  return "GraphQL request failed";
}

function combinedErrorText(problems, error) {
  const list = Array.isArray(problems) ? problems : [];
  return [...list, error ? shortGraphQlErrorLog(error) : ""]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function isCustomerFieldError(problems, error) {
  return /(?:\bcustomer\b|read_customers|protected customer|\bemail\b)/.test(
    combinedErrorText(problems, error),
  );
}

function isAddressFieldError(problems, error) {
  return /shippingaddress|billingaddress|shipping_address|billing_address/.test(
    combinedErrorText(problems, error),
  );
}

function isAccessDeniedError(problems, error) {
  return /access denied|access_denied/.test(combinedErrorText(problems, error));
}

function isCancelledAtFieldError(problems, error) {
  return /cancelledat/.test(combinedErrorText(problems, error));
}

function isOutstandingFieldError(problems, error) {
  return /totaloutstandingset/.test(combinedErrorText(problems, error));
}

function isReceivedFieldError(problems, error) {
  return /totalreceivedset/.test(combinedErrorText(problems, error));
}

function isSearchQueryError(problems, error) {
  return /invalid.*query|search query|created_at/.test(combinedErrorText(problems, error));
}

function isGraphqlQueryError(error) {
  if (!error) return false;
  const name = String(error.name || error.constructor?.name || "");
  return name === "GraphqlQueryError" || Boolean(error.body);
}

function payloadData(payload) {
  if (!payload || typeof payload !== "object") return null;
  const data = payload.data ?? payload.body?.data;
  return data && typeof data === "object" && !Array.isArray(data) ? data : null;
}

async function fetchDashboardPage(admin, {
  includeCustomer,
  includeAddresses,
  includeCancelledAt,
  includeOutstanding = true,
  includeReceived = true,
  first,
  after,
  query,
}) {
  try {
    const response = await admin.graphql(
      buildOrdersQuery({
        includeCustomer,
        includeAddresses,
        includeCancelledAt,
        includeOutstanding,
        includeReceived,
      }),
      {
        variables: {
          first,
          after: after || null,
          query: query || null,
        },
      },
    );
    const json = await response.json();
    const problems = graphQlProblems(json);
    if (problems.length) {
      console.error("Dashboard GraphQL userErrors", problems.join("; "));
    }
    return { data: payloadData(json), problems, error: null };
  } catch (error) {
    // TypeError (non-iterable GraphQL errors) and GraphqlQueryError: keep body.data if present.
    const caught =
      error instanceof TypeError ||
      error?.name === "TypeError" ||
      isGraphqlQueryError(error) ||
      Boolean(error?.body?.data);
    const body = error?.body;
    const data = payloadData(body);
    const problems = graphQlProblems(body || error);
    const log = problems.join("; ") || shortGraphQlErrorLog(error);
    console.error("Dashboard GraphQL userErrors", log);
    if (!caught && !data) {
      return { data: null, problems, error };
    }
    return { data, problems, error };
  }
}

async function paginateOrders(admin, {
  includeCustomer,
  includeAddresses,
  includeCancelledAt,
  includeOutstanding = true,
  includeReceived = true,
  searchQuery,
  emptyShop,
}) {
  let shop = emptyShop;
  const orders = [];
  let after = null;
  let customerFail = false;
  let addressFail = false;
  let cancelledAtFail = false;
  let outstandingFail = false;
  let receivedFail = false;
  let queryFail = false;
  let gotData = false;

  for (let page = 0; page < Math.ceil(MAX_ORDERS / PAGE_SIZE); page += 1) {
    const { data, problems, error } = await fetchDashboardPage(admin, {
      includeCustomer,
      includeAddresses,
      includeCancelledAt,
      includeOutstanding,
      includeReceived,
      first: PAGE_SIZE,
      after,
      query: searchQuery,
    });
    if (isCustomerFieldError(problems, error)) {
      customerFail = true;
    } else if (includeCustomer && isAccessDeniedError(problems, error) && !isAddressFieldError(problems, error)) {
      customerFail = true;
    }
    if (isAddressFieldError(problems, error)) {
      addressFail = true;
    }
    if (isCancelledAtFieldError(problems, error)) {
      cancelledAtFail = true;
    }
    if (isOutstandingFieldError(problems, error)) outstandingFail = true;
    if (isReceivedFieldError(problems, error)) receivedFail = true;
    if (isSearchQueryError(problems, error)) queryFail = true;

    if (data?.shop) shop = data.shop;
    const orderConnection = data?.orders;
    if (orderConnection == null) {
      return {
        shop,
        orders,
        customerFail,
        addressFail,
        cancelledAtFail,
        outstandingFail,
        receivedFail,
        queryFail,
        failed: !gotData,
      };
    }

    gotData = true;
    const nodes = Array.isArray(orderConnection.nodes) ? orderConnection.nodes : [];
    orders.push(...nodes);
    const pageInfo = orderConnection.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor || orders.length >= MAX_ORDERS) break;
    after = pageInfo.endCursor;
  }

  return {
    shop,
    orders: orders.slice(0, MAX_ORDERS),
    customerFail,
    addressFail,
    cancelledAtFail,
    outstandingFail,
    receivedFail,
    queryFail,
    failed: !gotData,
  };
}

export async function loadDashboardOrders(admin) {
  const emptyShop = { name: "Store", myshopifyDomain: "", currencyCode: "INR" };
  const historyQuery = createdAtQuery();

  let includeCustomer = true;
  let includeAddresses = true;
  let includeCancelledAt = true;
  let includeOutstanding = true;
  let includeReceived = true;
  let searchQuery = historyQuery;
  let result;

  const pageOpts = (overrides = {}) => ({
    includeCustomer,
    includeAddresses,
    includeCancelledAt,
    includeOutstanding,
    includeReceived,
    searchQuery,
    emptyShop,
    ...overrides,
  });

  try {
    result = await paginateOrders(admin, pageOpts());

    // Customer fields failed: retry once without customer; never request email. KEEP addresses.
    if (result.customerFail && includeCustomer) {
      includeCustomer = false;
      const retry = await paginateOrders(admin, pageOpts({ includeAddresses: true }));
      if (!retry.failed || (retry.orders || []).length >= (result.orders || []).length) {
        result = retry;
      }
    }

    // Strip addresses only when those fields specifically fail.
    if (result.addressFail && includeAddresses) {
      includeAddresses = false;
      const retry = await paginateOrders(admin, pageOpts());
      if (!retry.failed || (retry.orders || []).length >= (result.orders || []).length) {
        result = retry;
      }
    }

    if (result.cancelledAtFail && includeCancelledAt) {
      includeCancelledAt = false;
      const retry = await paginateOrders(admin, pageOpts());
      if (!retry.failed || (retry.orders || []).length >= (result.orders || []).length) {
        result = retry;
      }
    }

    if (result.outstandingFail && includeOutstanding) {
      includeOutstanding = false;
      const retry = await paginateOrders(admin, pageOpts());
      if (!retry.failed || (retry.orders || []).length >= (result.orders || []).length) {
        result = retry;
      }
    }

    if (result.receivedFail && includeReceived) {
      includeReceived = false;
      const retry = await paginateOrders(admin, pageOpts());
      if (!retry.failed || (retry.orders || []).length >= (result.orders || []).length) {
        result = retry;
      }
    }

    if (result.queryFail || (result.failed && searchQuery)) {
      searchQuery = null;
      result = await paginateOrders(admin, pageOpts());
    }

    if (result.failed) {
      result = await paginateOrders(admin, pageOpts({
        includeCustomer: false,
        includeAddresses: !result.addressFail,
        includeCancelledAt: !result.cancelledAtFail,
        includeOutstanding: !result.outstandingFail,
        includeReceived: !result.receivedFail,
        searchQuery: null,
      }));
    }

    if (result.failed && !(result.orders || []).length) {
      return { shop: result.shop || emptyShop, orders: [] };
    }

    return { shop: result.shop || emptyShop, orders: result.orders || [] };
  } catch (error) {
    console.error("Dashboard GraphQL userErrors", shortGraphQlErrorLog(error));
    if (result?.orders?.length) {
      return { shop: result.shop || emptyShop, orders: result.orders };
    }
    return { shop: emptyShop, orders: [] };
  }
}
