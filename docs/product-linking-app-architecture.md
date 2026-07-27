# Product Linking App — Architecture & Implementation Guide

## The Problem

Shopify's native variant system is limited to **100 variants per product** and **3 option axes** (e.g., Color / Size / Material). For stores that sell products with many configuration dimensions — electronics with storage, RAM, color, screen size, processor; furniture with fabric, frame, size, finish — this cap is quickly exhausted.

The common workaround is to split each configuration into a **separate Shopify product** and link them together so they *behave* like variants in the storefront. The customer sees pill selectors for "128 GB / 256 GB / 512 GB" and clicking one navigates to the corresponding product page.

### Why this is hard

1. **Shopify Liquid can't query products.** Templates can only read data already attached to the current product — they can't search the catalog at render time.
2. **Every store is different.** An electronics store uses `ram_gb` and `storage_gb`; a watch store uses `case_size_mm` and `band_material`; a clothing store uses `sleeve_length` and `fabric`. Hardcoding metafield keys makes the solution single-store.
3. **Dimension detection is non-trivial.** Given a family of 12 products, the app must figure out *which* attributes vary (and are worth showing as selectors) vs. which are constant across the family.
4. **Stale data.** When a merchant adds or removes a product from a family, all siblings' linking data must be recomputed. Partial updates cause broken navigation.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│                  Merchant UI                     │
│  - Assign products to families                   │
│  - Configure display: pills vs swatches          │
│  - Override labels, sort order, visibility        │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────┐
│              App Backend (Server)                 │
│                                                   │
│  1. Read product families                         │
│  2. Fetch sibling metafields via Admin API        │
│  3. Detect varying dimensions (set comparison)    │
│  4. Write precomputed linking data back to        │
│     products as app-owned metafields              │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────┐
│         Theme App Extension (Block)              │
│                                                   │
│  Reads app-owned metafields (numbered slots)      │
│  Renders variant selectors generically            │
│  No store-specific knowledge needed               │
└─────────────────────────────────────────────────┘
```

The app acts as a **compiler**: it transforms store-specific metafield data into a standardized format that a generic theme block can render.

---

## Step 1 — Product Family Grouping

### App-owned metafield

On install, the app creates a metafield definition:

```
Namespace:  app--<your-app-handle>
Key:        product_family
Type:       single_line_text_field
Owner type: PRODUCT
```

Using the app's reserved namespace ensures no collisions with merchant metafields or other apps.

### Assigning families

The merchant assigns a family identifier to each product (e.g., `"iphone-16"`, `"herman-miller-aeron"`). This can happen through:

- **Manual assignment** in the app's admin UI
- **Auto-detection** — the app proposes families based on heuristics (shared `product_type` + title stem), and the merchant confirms or edits
- **Bulk import** via CSV

### Querying siblings

Once a product's family value is known, all siblings are a single query:

```graphql
{
  products(first: 50, query: "meta.app--<your-app>.product_family:'iphone-16'") {
    nodes {
      id
      title
      handle
      featuredImage { url }
      metafields(first: 30, namespace: "custom") {
        nodes { key value type }
      }
    }
  }
}
```

> **Requirement:** The metafield must have a **definition** in Shopify for query filtering to work. Ad-hoc metafield values (without definitions) are not indexed.

---

## Step 2 — Dimension Detection

Given a family of sibling products with their metafields, the app determines which attributes vary.

### Algorithm

```
Input:  List of sibling products, each with a dict of metafield key→value
Output: List of varying dimensions with their unique values

for each metafield key present across any sibling:
    collect all non-null values for this key across siblings
    if count(unique values) > 1:
        mark as VARYING dimension
    else:
        mark as CONSTANT (skip)
```

### Example

| Product              | `storage_gb` | `ram_gb` | `variant_color` | `brand`  |
|----------------------|-------------|---------|-----------------|----------|
| iPhone 16 — 128GB Black | 128     | 8       | Black           | Apple    |
| iPhone 16 — 256GB Black | 256     | 8       | Black           | Apple    |
| iPhone 16 — 128GB White | 128     | 8       | White           | Apple    |
| iPhone 16 — 256GB White | 256     | 8       | White           | Apple    |

- `storage_gb`: values `{128, 256}` → **varying**
- `variant_color`: values `{Black, White}` → **varying**
- `ram_gb`: values `{8}` → constant, skip
- `brand`: values `{Apple}` → constant, skip

Result: two variant dimensions — Storage and Color.

### Handling multiple metafield keys for the same concept

Merchants may name their metafields inconsistently. A "screen size" might be stored as `display_size_in`, `screen_size_in`, or `screen_size_inches`. The app can handle this via:

- **Canonical mapping** — the app maintains a dictionary of known aliases per concept
- **Merchant configuration** — the UI lets the merchant explicitly mark which metafield(s) represent each dimension
- **Ignore the problem** — if the app only compares keys that are identically named across siblings, aliases that differ won't match. This is acceptable if the same store is internally consistent (which it usually is)

### Edge case: N-dimensional families

A family of laptops might vary across **3+ dimensions** simultaneously (storage, RAM, color, processor, screen size). The app must handle this:

- Detect all varying dimensions independently
- For the theme to navigate correctly when the customer selects *one* dimension, the link target should change only that dimension while preserving the others. This requires finding the "closest sibling" — the product that matches the current product on all dimensions except the one being changed.
- If no exact match exists (sparse matrix), the app can either: (a) link to the closest available match, (b) grey out unavailable combinations, or (c) omit the option entirely.

---

## Step 3 — Writing Precomputed Linking Data

Since Liquid templates cannot make API calls, the app writes precomputed data to each product using **app-owned metafields in numbered slots**.

### Metafield schema

For each product, the app writes:

| Metafield key | Type | Purpose |
|---|---|---|
| `variant_group_0` | `list.product_reference` | Product references for the 1st varying dimension |
| `variant_label_0` | `single_line_text_field` | Display label (e.g., "Internal Storage") |
| `variant_display_0` | `single_line_text_field` | Render mode: `pill`, `image_swatch`, `color_dot` |
| `variant_value_key_0` | `single_line_text_field` | Metafield key to read the display value from (e.g., `storage_gb`) |
| `variant_value_suffix_0` | `single_line_text_field` | Unit suffix (e.g., ` GB`) |
| `variant_group_1` | `list.product_reference` | 2nd dimension |
| `variant_label_1` | `single_line_text_field` | ... |
| ... | ... | Up to N dimensions |
| `variant_dimension_count` | `number_integer` | How many dimension slots are populated |

All in namespace `app--<your-app-handle>`.

### Writing via Admin API

```graphql
mutation {
  metafieldsSet(metafields: [
    {
      ownerId: "gid://shopify/Product/123456"
      namespace: "app--<your-app>"
      key: "variant_group_0"
      type: "list.product_reference"
      value: "[\"gid://shopify/Product/111\", \"gid://shopify/Product/222\"]"
    },
    {
      ownerId: "gid://shopify/Product/123456"
      namespace: "app--<your-app>"
      key: "variant_label_0"
      type: "single_line_text_field"
      value: "Internal Storage"
    },
    {
      ownerId: "gid://shopify/Product/123456"
      namespace: "app--<your-app>"
      key: "variant_display_0"
      type: "single_line_text_field"
      value: "pill"
    }
  ]) {
    metafields { id }
    userErrors { field message }
  }
}
```

### Cleanup: removing stale data

When a product is removed from a family or a dimension no longer varies, the app must **delete** the corresponding metafields. Orphaned `list.product_reference` entries pointing to removed products cause broken links.

```graphql
mutation {
  metafieldsDelete(metafields: [
    { ownerId: "gid://shopify/Product/123456", namespace: "app--<your-app>", key: "variant_group_2" }
  ]) {
    deletedMetafields { ownerId namespace key }
    userErrors { message }
  }
}
```

Always delete unused slots when `variant_dimension_count` decreases.

### Recomputation triggers

The app should recompute linking data when:

- A product is added to or removed from a family
- A product's spec metafields change (via webhook: `products/update`)
- A product is deleted (via webhook: `products/delete`)
- The merchant changes display configuration in the app UI
- Bulk recompute on demand (admin action)

---

## Step 4 — Theme Rendering (App Block)

The app ships a **Theme App Extension** containing an app block that merchants add to their product page template.

### Generic Liquid rendering

The block iterates numbered slots without any knowledge of what the store sells:

```liquid
{%- assign app_ns = 'app--<your-app>' -%}
{%- assign dim_count = product.metafields[app_ns]['variant_dimension_count'].value | default: 0 | plus: 0 -%}

{%- for i in (0..9) -%}
  {%- if i >= dim_count -%}{%- break -%}{%- endif -%}

  {%- assign group_key = 'variant_group_' | append: i -%}
  {%- assign label_key = 'variant_label_' | append: i -%}
  {%- assign display_key = 'variant_display_' | append: i -%}
  {%- assign valkey_key = 'variant_value_key_' | append: i -%}
  {%- assign suffix_key = 'variant_value_suffix_' | append: i -%}

  {%- assign refs = product.metafields[app_ns][group_key].value -%}
  {%- assign label = product.metafields[app_ns][label_key].value -%}
  {%- assign display_mode = product.metafields[app_ns][display_key].value | default: 'pill' -%}
  {%- assign value_mf = product.metafields[app_ns][valkey_key].value -%}
  {%- assign suffix = product.metafields[app_ns][suffix_key].value | default: '' -%}

  {%- if refs == blank or label == blank -%}{%- continue -%}{%- endif -%}

  <div class="variant-selector">
    <p class="variant-selector__label">{{ label }}</p>
    <div class="variant-selector__options">
      {%- for ref in refs -%}
        {%- if ref == blank or ref.handle == blank -%}{%- continue -%}{%- endif -%}

        {%- assign is_current = false -%}
        {%- if ref.id == product.id -%}{%- assign is_current = true -%}{%- endif -%}

        {%- assign display_val = '' -%}
        {%- if value_mf != blank -%}
          {%- assign display_val = ref.metafields.custom[value_mf].value | append: suffix -%}
        {%- endif -%}
        {%- if display_val == blank -%}
          {%- assign display_val = ref.title -%}
        {%- endif -%}

        <a href="{{ ref.url }}"
           class="variant-option variant-option--{{ display_mode }}{% if is_current %} is-active{% endif %}">
          {%- if display_mode == 'image_swatch' -%}
            {%- if ref.featured_image -%}
              <img src="{{ ref.featured_image | image_url: width: 140 }}"
                   alt="{{ ref.title | escape }}" loading="lazy" width="70" height="70">
            {%- endif -%}
            <span>{{ display_val }}</span>
          {%- else -%}
            {{ display_val }}
          {%- endif -%}
        </a>
      {%- endfor -%}
    </div>
  </div>
{%- endfor -%}
```

This block works identically for an electronics store, a clothing store, and a furniture store. The app backend does all the store-specific work; the theme block is generic.

### Solo fallback

When a product has only one option for a dimension (e.g., only one color available), the `list.product_reference` still contains that single product. The block renders it as a single active pill. This communicates the spec to the customer even when there's nothing to choose.

The app backend controls this behavior: if the merchant prefers to hide single-option selectors, the app simply doesn't write that dimension slot.

---

## Step 5 — Closest-Sibling Navigation

This is the most critical UX concern. When a customer views a "Laptop — 16″ / M5 Pro / 512 GB / Space Black" and clicks "1 TB" in the storage selector, the target must be "Laptop — 16″ / M5 Pro / **1 TB** / Space Black" — changing only the selected dimension.

### The problem

In a family with N varying dimensions, the product matrix may be **sparse** — not every combination exists. Naively linking to "any sibling with 1 TB storage" might land on a 14″ model with a different processor.

### Solution: Constraint-preserving lookup

When computing the `list.product_reference` for a given dimension, the app should only include siblings that match the current product on **all other dimensions**:

```
For product P, dimension D:
  candidates = all siblings in P's family
  for each other varying dimension D':
    candidates = candidates.filter(c => c[D'] == P[D'])
  variant_group[D] = candidates (sorted by D's value)
```

This means the reference list is **product-specific**, not family-wide. Product A's storage group may differ from Product B's storage group if they have different processors.

### Sparse matrix handling

If filtering leaves zero candidates for a value (the combination doesn't exist), the app has options:

1. **Omit** — don't include that value in the reference list (customer never sees it)
2. **Nearest match** — relax one constraint at a time and link to the closest match, with a visual indicator that other attributes will change
3. **Disabled state** — include the value but mark it as unavailable (render as greyed-out, non-clickable)

The recommended default is **omit** — it's the least confusing UX.

---

## Merchant Configuration UI

The app should provide a configuration interface with at least:

### Family management
- List all product families with member count
- Add/remove products from families
- Auto-suggest families based on product type and title patterns
- Bulk assign via CSV or tag-based rules

### Dimension settings (per family or global)
- Toggle visibility for each detected dimension
- Set display mode: `pill` (text), `image_swatch` (product image), `color_dot` (CSS color)
- Override the label (e.g., rename "ram_gb" → "Memory")
- Set value suffix (e.g., " GB", "″")
- Set sort order (numeric ascending, alphabetical, custom)
- Choose sparse-matrix behavior (omit / nearest / disabled)

### Global settings
- Auto-recompute on product changes (on/off)
- Include single-option dimensions (on/off)
- Maximum dimensions to display

---

## Webhooks & Background Jobs

### Required webhooks

| Webhook | Action |
|---|---|
| `products/update` | Check if spec metafields changed → recompute family |
| `products/delete` | Remove from family → recompute remaining siblings |
| `app/uninstalled` | Clean up app-owned metafields |

### Job architecture

Recomputation should be **queued, not synchronous**. A single product update in a family of 50 products triggers metafield writes to all 50. This should happen in a background job with:

- Debouncing — if multiple products in the same family update within a short window, batch into one recompute
- Idempotency — rerunning the same job produces the same result
- Failure handling — if a metafield write fails, retry without corrupting other siblings

---

## API Rate Limits & Optimization

### Shopify Admin API limits

- REST: 40 requests per app per store per minute (with leaky bucket)
- GraphQL: 1,000 cost points per second (with throttle)

### Strategies

- **Batch metafield writes** — `metafieldsSet` accepts up to 25 metafields per call. Group writes by product.
- **Bulk operations** — for initial setup or full recompute, use Shopify's `bulkOperationRunQuery` to fetch all products with metafields in a single async job, avoiding pagination limits.
- **Cache product data** — store fetched product/metafield data in the app's database. Only refetch on webhook triggers.
- **Incremental updates** — when one product changes, only recompute its family, not the entire catalog.

---

## Storefront API Considerations

If the app uses a **client-side approach** (JavaScript in the storefront) instead of precomputed metafields:

- The Storefront API supports metafield filtering since API version `2024-01+`
- Client-side queries add latency (the variant selectors appear after a network round-trip)
- Storefront API has stricter rate limits and doesn't expose all metafield types
- Product reference metafields are automatically resolved in the Storefront API, making them ideal for this use case

The precomputed metafield approach (Option B) is recommended for performance-critical storefronts.

---

## Summary

| Component | Responsibility |
|---|---|
| **App Backend** | Family management, dimension detection, constraint-preserving sibling computation, metafield writes |
| **App-owned Metafields** | Standardized numbered slots that encode linking data for any store |
| **Theme App Extension** | Generic block that reads numbered slots and renders selectors — zero store knowledge |
| **Webhooks + Jobs** | Keep linking data fresh when products change |
| **Merchant UI** | Configure families, dimension visibility, display modes, labels |

The app is the bridge between store-specific product data and a universal rendering format. The store can sell phones, sofas, or sneakers — the pipeline is identical.
