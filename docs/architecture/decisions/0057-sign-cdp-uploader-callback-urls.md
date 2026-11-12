# 57. Sign CDP Uploader callback URLs

Date: 2026-11-10

## Status

Accepted

| ADR                                                       | Title                                     | Relationship                                                                                                    |
| --------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [0035](0035-read-organisation-data-with-basic-auth.md)    | Read organisation data with Basic Auth    | Unrelated mechanism: Basic Auth guards the organisation list routes only, never the upload callbacks.           |
| [0053](0053-address-resources-by-natural-key-and-year.md) | Address resources by natural key and year | Builds on: the summary log callback path carries the organisation, registration, year and accreditation signed. |

## Context

`epr-backend` uploads files (summary logs and overseas reprocessing site imports) through [CDP Uploader](https://github.com/DEFRA/cdp-uploader). When an upload starts, the backend gives CDP Uploader a callback URL and the bucket and path to store the file under. Once the file is scanned and stored, CDP Uploader calls that URL with the result, which names where the file was stored.

The callback routes were unauthenticated. Nothing tied a callback to an upload the backend had started, so the backend trusted whatever location a callback named, read it with its own permissions, and stored the result against the organisation and registration in the path.

[CDP's file upload guidance](https://github.com/DEFRA/cdp-documentation/blob/main/how-to/file-upload.md) says callbacks should be authenticated and their contents validated. CDP Uploader itself offers no mechanism: it calls the callback URL exactly as given, sends no credentials or signature, and the result carries no upload id.

## Decision

### Sign the callback URL

When it starts an upload, the backend signs the callback URL it hands to CDP Uploader with a keyed hash (HMAC) of the callback path, using a secret only the backend holds. When a callback arrives, the backend checks the signature against the path it was called on, and refuses the callback before acting on it if the signature is missing or does not match.

The signature covers the whole path, so it fixes every identifier the path carries (organisation, registration, year, accreditation and summary log, or the import). A signed URL is good for the one upload it was made for.

### Check where the file is

A correctly signed callback is still checked for where its file is: it must be in the bucket and under the path the backend gave CDP Uploader for that upload. The backend reads and deletes uploaded files only from its upload buckets.

### The key

- a random secret, with no default in the code, so the backend does not start without one
- held as a CDP portal secret, different in each environment
- a fixed development key in the compose files for local and CI stacks, which deployed environments refuse

### Alternatives considered

- **Rely on the protected zone.** Any service on the platform can reach the backend, so network position alone does not show that a callback came from CDP Uploader for an upload we started.
- **Basic Auth or a shared header.** CDP Uploader sends no credentials or custom headers on callbacks.
- **Match the callback to a pending upload record, or ask CDP Uploader's status endpoint.** The callback carries no upload id to match or look up. The signed path already binds the callback to the upload's identifiers without storing anything new.

## Consequences

- Only a party holding the key can make a callback the backend accepts, and only for the upload it was signed for.
- The backend reads and stores files only from the location its own upload put them in.
- A new secret has to exist in every environment before the release that needs it; without it the backend does not start.
- Rotating the key, or the first release, invalidates callback URLs signed with the previous key. Uploads in progress during that deployment are refused and have to be uploaded again. This is accepted; accepting a previous key during rotation can be added if it is ever needed.
- The release order is: development keys in the compose files, secrets in each environment, then the backend change.
