# GoHighLevel (GHL) leads

GoHighLevel is a CRM many agencies use to catch the leads their ads bring in. If your leads land in GHL, Studio can count them per client and credit each one to the ad that brought it in. It only reads.

GHL is **optional**. The default for every client is **Meta leads**: Meta's own lead count, with no GHL at all. Set up GHL only if your lead forms send contacts into GHL and you trust those counts more than Meta's.

## What it powers

- The **Leads** and **cost per lead** numbers on the Running tab, per client and per ad, when the client's Leads setting is **GHL leads** or **Meta, then GHL**.
- Per ad lead credit, which feeds the **winner** flag, hook rows' lead numbers and the cost per lead column of **calibration** on the Rubric page.

## What it costs

Nothing on Studio's side. Studio makes one kind of request: a contacts search.

## How Studio finds your leads

For each client with GHL leads on, Studio searches the GHL location for contacts whose **source** equals the client's GHL source:

- Default source: `<code>-fb-ad`, for example `crumb-fb-ad` for a client with the code `crumb`.
- You can type another one in **Settings > Clients > Edit > GHL source** (letters, digits, dot, dash or underscore, up to 64).

So your GHL forms or funnels for that client must set the contact's source to that value.

To credit a lead to a single ad, Studio reads the contact's first touch attribution (`utmContent`), and falls back to the last touch. It expects `utmContent` to be the **ad name** as it appears in Meta. A common way to get that is a `utm_content={{ad.name}}` URL parameter on your Meta ads. Leads that do not name an ad still count in the client's totals; the Running tab lists them as "not tied to an ad".

Contacts tagged `test record` or `claude-test-lead` are marked as tests and left out of every count.

## Connect it

1. GHL needs the same env file as the Clients lane's Meta token, `META_ENV_FILE` (default `~/.studio/meta.env`). Open it:

```bash
open -e ~/.studio/meta.env
```

2. Add two lines and save:

```text
GHL_API_KEY=paste-your-key-here
GHL_LOCATION_ID=your-location-id
```

`GHL_API_KEY` must be a key that can search contacts in that location (a GHL private integration token with read access to contacts works). `GHL_LOCATION_ID` is the id of the GHL sub-account (location) your leads land in.

3. For each client, open **Settings > Clients > Edit**, set **Leads** to **GHL leads** or **Meta, then GHL**, and fill **GHL source** if it is not `<code>-fb-ad`.
4. Click **Sync now** in **Settings > Meta and GHL**. Leads are read in the same run as the Meta numbers.

The Company lane uses the same key from `META_ENV_FILE` (there is no separate GHL key for it). Its Leads mode and source are set in `studio.config.json` (`lanes.fkb.leads`, `lanes.fkb.ghlSource`; the default source is `fkb-fb-ad`).

### Several GHL locations

If a lane's leads live in another GHL location than `GHL_LOCATION_ID`, set `ghlLocation` for that lane in `studio.config.json` (`lanes.fkbpros.ghlLocation` for every client, `lanes.fkb.ghlLocation` for the Company lane). Like the other lane options it is read once, on the first start that sees it. See [configuration](../configuration.md).

## Check that it works

In **Settings > Meta and GHL**:

- **GHL key (client leads)** shows yes when the env file has both `GHL_API_KEY` and `GHL_LOCATION_ID`.
- In the account table, the **Leads** column says **GHL** or **Meta** for each account, with "pulled <time>" after a good GHL read. A GHL problem shows as an orange line starting with "GHL:".

## What Studio reads, and what it never does

- Studio sends exactly one request type: `POST https://services.leadconnectorhq.com/contacts/search`, filtered on the source. It is a POST because that is how GHL's search works, but it only reads. The code refuses any other URL or method before a connection opens.
- Studio keeps only: the contact id, the date it was added, the test flag, and the first and last touch `utmContent` and `mediumId` (the GHL form id). **No names, phone numbers, emails, addresses, notes or any other contact detail** are stored, logged or shown.
- The key is read fresh for each request and sent only in the `Authorization` header. It never goes into the database, a log, an error message or the browser.
- A read stops after 50 pages of 100 contacts. Studio removes stored leads that GHL no longer returns **only after a complete read**. A partial read only adds and updates, keeps every lead it already had, and leaves the note "GHL returned a partial list (N contacts): nothing removed, M stored leads kept."
- A GHL failure never touches the Meta numbers.

## Switch it off

- One client: set its **Leads** back to **Meta leads** in **Settings > Clients > Edit**. Studio then reads no GHL for it.
- Everything: remove `GHL_API_KEY` and `GHL_LOCATION_ID` from the env file. Clients on **GHL leads** then show "GHL_API_KEY or GHL_LOCATION_ID missing from the Meta env file."; clients on **Meta, then GHL** quietly use Meta leads.

## Common problems

See [troubleshooting](../troubleshooting.md#ghl-lead-errors).
