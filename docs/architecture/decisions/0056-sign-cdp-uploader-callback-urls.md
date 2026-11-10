# 56. Sign CDP Uploader callback URLs

Date: 2026-11-10

## Status

Accepted

| ADR                                                       | Title                                     | Relationship                                                                                                    |
| --------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [0035](0035-read-organisation-data-with-basic-auth.md)    | Read organisation data with Basic Auth    | Unrelated mechanism: Basic Auth guards the organisation list routes only, never the upload callbacks.           |
| [0053](0053-address-resources-by-natural-key-and-year.md) | Address resources by natural key and year | Builds on: the summary log callback path carries the organisation, registration, year and accreditation signed. |

## Context

`epr-backend` uploads files through [CDP Uploader](https://github.com/DEFRA/cdp-uploader). When an upload starts, the backend calls `POST /initiate` with a callback URL, a bucket and a path. Once the file is scanned and stored, CDP Uploader `POST`s the result to that callback URL. The result names the bucket and key the file was stored under.

Two routes receive these callbacks:

- summary logs: `POST /organisations/{organisationNumber}/registrations/{registrationNumber}/summary-logs/{year}/{summaryLogId}/upload-completed`, and the accredited equivalent under `/accreditations/{year}/summary-log`
- overseas reprocessing sites (ORS) imports: `POST /v1/overseas-sites/imports/{id}/upload-completed`

Both were registered with `auth: false`. Nothing tied a callback to an upload the backend had started, so the backend trusted whatever bucket and key a callback named. It went on to read that location with its own IAM role, and to store the result against the organisation and registration in the path.

[CDP's file upload guidance](https://github.com/DEFRA/cdp-documentation/blob/main/how-to/file-upload.md) says callbacks should be authenticated and their contents validated. CDP Uploader itself offers no mechanism: it posts to the callback URL exactly as given, adds no header or signature, and the payload carries no `uploadId`.

## Decision

### Sign the callback URL

At initiate, the backend appends a signature to the callback URL it gives CDP Uploader:

```text
{appBaseUrl}{path}?signature={hex HMAC-SHA256(key, path)}
```

The signature covers the whole path, so it fixes every identifier the path carries: organisation and registration numbers, year, accreditation and summary log id, or the ORS import id.

Both callback routes use a Hapi auth strategy, `upload-callback`, in place of `auth: false`. It recomputes the HMAC over `request.path` and compares it with `timingSafeEqual`. A missing signature, or one made for another path, gets `401` before the handler runs.

### Pin the bucket and key prefix

A signed callback is still checked for where its file is:

- a completed file must be in the configured bucket (`cdpUploader.summaryLogsBucket` or `cdpUploader.orsBucket`)
- its key must sit under the path the backend gave at initiate: `/organisations/{organisationId}/registrations/{registrationId}/` for summary logs, `/overseas-sites/imports/{importId}/` for ORS

A file anywhere else gets `422` and nothing is stored. The uploads repository also refuses to read or delete outside the upload buckets.

`s3://bucket/key` locations are parsed as a bucket and a literal key, not as URLs. S3 keys are literal, so a URL parse would change the key that gets read (for example by resolving `..` segments).

### Key

- environment variable `CDP_UPLOADER_CALLBACK_HMAC_KEY` (convict `cdpUploader.callbackHmacKey`, `sensitive`)
- 32 random bytes as 64 lowercase hex characters, generated with `openssl rand -hex 32`
- no default: the backend refuses to start without a valid key
- outside `local`, a key made of a repeated pattern is refused at startup; this catches the all-zeros development key the compose files use
- set per environment as a CDP portal secret, with a different key in each environment

### Alternatives considered

- **Rely on the protected zone.** Any service on the platform can reach the backend, so network position alone does not show that a callback came from CDP Uploader for an upload we started.
- **Basic Auth or a shared header.** CDP Uploader sends no credentials or custom headers on callbacks.
- **Match the callback to a pending upload record, or ask CDP Uploader's status endpoint.** The callback payload carries no `uploadId` to match or look up. The signed path already binds the callback to the upload's identifiers without storing anything new.

## Consequences

- Only a party holding the key can make a callback the backend accepts, and only for the path it was signed for.
- The backend reads and stores files only from the location its own upload put them in.
- A new secret has to exist in every environment before the release that needs it; without it the backend does not start. The service repo and journey test compose files carry a fixed development key so local and CI stacks keep working.
- Rotating the key, or the first release, invalidates callback URLs signed with the previous key. Uploads in progress during that deployment get `401` and have to be uploaded again. This is accepted; accepting a previous key during rotation can be added if it is ever needed.
- The release order is: compose keys on main, portal secrets in each environment, then the backend change.
