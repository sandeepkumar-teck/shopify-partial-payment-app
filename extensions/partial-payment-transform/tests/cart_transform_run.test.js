import { describe, expect, test } from "vitest";
import { cartTransformRun } from "../src/cart_transform_run";

describe("cartTransformRun", () => {
  test("expands a partial-pay line to the deposit unit price", () => {
    const result = cartTransformRun({
      cart: {
        lines: [
          {
            id: "gid://shopify/CartLine/0",
            quantity: 1,
            depositNow: { value: "200" },
            payNow: null,
            payNowVisible: { value: "₹200" },
            remainingCod: { value: "₹400" },
            fullPriceVisible: { value: "₹600" },
            statusVisible: { value: "Partial paid" },
            surchargeLine: { value: null },
            codExtra: { value: null },
            cost: { amountPerQuantity: { amount: "600.0" } },
            merchandise: {
              __typename: "ProductVariant",
              id: "gid://shopify/ProductVariant/1",
              title: "Default Title",
              product: { title: "The Collection Snowboard: Hydrogen" },
            },
          },
        ],
      },
    });

    expect(result.operations).toHaveLength(1);
    const expand = result.operations[0].lineExpand;
    expect(expand.cartLineId).toBe("gid://shopify/CartLine/0");
    expect(expand.expandedCartItems[0].price.adjustment.fixedPricePerUnit.amount).toBe("200.00");
    expect(expand.expandedCartItems[0].quantity).toBe(1);
    expect(expand.expandedCartItems[0].attributes).toEqual([
      { key: "Pay now", value: "₹200" },
      { key: "Remaining COD", value: "₹400" },
      { key: "Full price", value: "₹600" },
      { key: "Status", value: "Partial paid" },
    ]);
    expect(expand.title).toBe("The Collection Snowboard: Hydrogen");
  });

  test("copies visible properties onto each expanded line in a two-item cart", () => {
    const result = cartTransformRun({
      cart: {
        lines: [
          {
            id: "gid://shopify/CartLine/0",
            quantity: 1,
            payNowVisible: { value: "₹300" },
            remainingCod: { value: "₹700" },
            fullPriceVisible: { value: "₹1000" },
            statusVisible: { value: "Partial paid" },
            surchargeLine: { value: null },
            codExtra: { value: null },
            cost: { amountPerQuantity: { amount: "1000.0" } },
            merchandise: {
              __typename: "ProductVariant",
              id: "gid://shopify/ProductVariant/1",
              title: "A",
              product: { title: "Product A" },
            },
          },
          {
            id: "gid://shopify/CartLine/1",
            quantity: 1,
            payNowVisible: { value: "₹200" },
            remainingCod: { value: "₹400" },
            fullPriceVisible: { value: "₹600" },
            statusVisible: { value: "Partial paid" },
            surchargeLine: { value: null },
            codExtra: { value: null },
            cost: { amountPerQuantity: { amount: "600.0" } },
            merchandise: {
              __typename: "ProductVariant",
              id: "gid://shopify/ProductVariant/2",
              title: "B",
              product: { title: "Product B" },
            },
          },
        ],
      },
    });

    expect(result.operations).toHaveLength(2);
    expect(result.operations[0].lineExpand.expandedCartItems[0].attributes).toEqual([
      { key: "Pay now", value: "₹300" },
      { key: "Remaining COD", value: "₹700" },
      { key: "Full price", value: "₹1000" },
      { key: "Status", value: "Partial paid" },
    ]);
    expect(result.operations[1].lineExpand.expandedCartItems[0].attributes).toEqual([
      { key: "Pay now", value: "₹200" },
      { key: "Remaining COD", value: "₹400" },
      { key: "Full price", value: "₹600" },
      { key: "Status", value: "Partial paid" },
    ]);
  });

  test("zeros leftover surcharge product lines", () => {
    const result = cartTransformRun({
      cart: {
        lines: [
          {
            id: "gid://shopify/CartLine/1",
            quantity: 1,
            depositNow: { value: "0" },
            payNowVisible: { value: "₹0" },
            remainingCod: { value: "₹1100" },
            fullPriceVisible: { value: "₹1100" },
            statusVisible: { value: "Unpaid (COD)" },
            surchargeLine: { value: null },
            codExtra: { value: "₹500" },
            cost: { amountPerQuantity: { amount: "600.0" } },
            merchandise: {
              __typename: "ProductVariant",
              id: "gid://shopify/ProductVariant/1",
              title: "Default",
              product: { title: "Snowboard" },
            },
          },
          {
            id: "gid://shopify/CartLine/2",
            quantity: 1,
            depositNow: { value: null },
            surchargeLine: { value: "1" },
            codExtra: { value: null },
            cost: { amountPerQuantity: { amount: "500.0" } },
            merchandise: {
              __typename: "ProductVariant",
              id: "gid://shopify/ProductVariant/9",
              title: "COD extra",
              product: { title: "COD extra charge" },
            },
          },
        ],
      },
    });

    expect(result.operations).toHaveLength(2);
    expect(result.operations[0].lineExpand.expandedCartItems[0].price.adjustment.fixedPricePerUnit.amount).toBe(
      "500.00",
    );
    expect(result.operations[1].lineExpand.cartLineId).toBe("gid://shopify/CartLine/2");
    expect(result.operations[1].lineExpand.expandedCartItems[0].price.adjustment.fixedPricePerUnit.amount).toBe(
      "0.00",
    );
  });

  test("charges only the COD extra share on FULLY COD product lines", () => {
    const result = cartTransformRun({
      cart: {
        lines: [
          {
            id: "gid://shopify/CartLine/3",
            quantity: 1,
            depositNow: { value: null },
            payNow: null,
            payNowVisible: { value: "₹500" },
            remainingCod: { value: "₹600" },
            fullPriceVisible: { value: "₹600" },
            statusVisible: { value: "Unpaid (COD)" },
            surchargeLine: { value: null },
            codExtra: { value: "₹500" },
            cost: { amountPerQuantity: { amount: "600.0" } },
            merchandise: {
              __typename: "ProductVariant",
              id: "gid://shopify/ProductVariant/2",
              title: "Default",
              product: { title: "Snowboard" },
            },
          },
        ],
      },
    });

    expect(result.operations).toHaveLength(1);
    expect(result.operations[0].lineExpand.expandedCartItems[0].price.adjustment.fixedPricePerUnit.amount).toBe(
      "500.00",
    );
  });

  test("splits one order extra across FULLY COD lines as checkout prices", () => {
    const result = cartTransformRun({
      cart: {
        lines: [
          {
            id: "gid://shopify/CartLine/a",
            quantity: 1,
            payNowVisible: { value: "₹300" },
            remainingCod: { value: "₹600" },
            fullPriceVisible: { value: "₹600" },
            statusVisible: { value: "Unpaid (COD)" },
            surchargeLine: { value: null },
            codExtra: { value: "₹300" },
            cost: { amountPerQuantity: { amount: "600.0" } },
            merchandise: {
              __typename: "ProductVariant",
              id: "gid://shopify/ProductVariant/2",
              title: "A",
              product: { title: "Snowboard A" },
            },
          },
          {
            id: "gid://shopify/CartLine/b",
            quantity: 1,
            payNowVisible: { value: "₹200" },
            remainingCod: { value: "₹400" },
            fullPriceVisible: { value: "₹400" },
            statusVisible: { value: "Unpaid (COD)" },
            surchargeLine: { value: null },
            codExtra: { value: "₹200" },
            cost: { amountPerQuantity: { amount: "400.0" } },
            merchandise: {
              __typename: "ProductVariant",
              id: "gid://shopify/ProductVariant/3",
              title: "B",
              product: { title: "Snowboard B" },
            },
          },
        ],
      },
    });

    const amounts = result.operations.map(
      (op) => op.lineExpand.expandedCartItems[0].price.adjustment.fixedPricePerUnit.amount,
    );
    expect(amounts).toEqual(["300.00", "200.00"]);
  });

  test("FULLY COD leftover Pay now 0 still charges extra only, not catalog plus extra", () => {
    const result = cartTransformRun({
      cart: {
        lines: [
          {
            id: "gid://shopify/CartLine/legacy",
            quantity: 1,
            payNowVisible: { value: "₹0" },
            remainingCod: { value: "₹1100" },
            fullPriceVisible: { value: "₹1100" },
            statusVisible: { value: "Unpaid (COD)" },
            surchargeLine: { value: null },
            codExtra: { value: "₹500" },
            cost: { amountPerQuantity: { amount: "600.0" } },
            merchandise: {
              __typename: "ProductVariant",
              id: "gid://shopify/ProductVariant/2",
              title: "Default",
              product: { title: "Snowboard" },
            },
          },
        ],
      },
    });

    expect(result.operations).toHaveLength(1);
    expect(result.operations[0].lineExpand.expandedCartItems[0].price.adjustment.fixedPricePerUnit.amount).toBe(
      "500.00",
    );
  });

  test("leaves FULLY COD catalog price when no extra is present", () => {
    const result = cartTransformRun({
      cart: {
        lines: [
          {
            id: "gid://shopify/CartLine/4",
            quantity: 1,
            payNowVisible: { value: "₹0" },
            remainingCod: { value: "₹600" },
            fullPriceVisible: { value: "₹600" },
            statusVisible: { value: "Unpaid (COD)" },
            surchargeLine: { value: null },
            codExtra: { value: null },
            cost: { amountPerQuantity: { amount: "600.0" } },
            merchandise: {
              __typename: "ProductVariant",
              id: "gid://shopify/ProductVariant/2",
              title: "Default",
              product: { title: "Snowboard" },
            },
          },
        ],
      },
    });

    expect(result.operations).toEqual([]);
  });

  test("still expands to the deposit price even if a lineUpdate metafield is present", () => {
    const result = cartTransformRun({
      shop: { useLineUpdate: { value: "true" } },
      cartTransform: { useLineUpdate: { value: "true" } },
      cart: {
        lines: [
          {
            id: "gid://shopify/CartLine/0",
            quantity: 1,
            depositNow: { value: "500" },
            payNowVisible: { value: "₹500" },
            remainingCod: { value: "₹100" },
            fullPriceVisible: { value: "₹600" },
            statusVisible: { value: "Partial paid" },
            surchargeLine: { value: null },
            codExtra: { value: null },
            cost: { amountPerQuantity: { amount: "600.0" } },
            merchandise: {
              __typename: "ProductVariant",
              id: "gid://shopify/ProductVariant/1",
              title: "Default Title",
              product: { title: "The Collection Snowboard: Hydrogen" },
            },
          },
        ],
      },
    });

    expect(result.operations).toHaveLength(1);
    expect(result.operations[0].lineUpdate).toBeUndefined();
    const expand = result.operations[0].lineExpand;
    expect(expand.cartLineId).toBe("gid://shopify/CartLine/0");
    expect(expand.expandedCartItems[0].price.adjustment.fixedPricePerUnit.amount).toBe("500.00");
  });
});
