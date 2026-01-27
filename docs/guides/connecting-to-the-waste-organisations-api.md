# Connecting to the Waste Organisations API

The [Waste Organisations API is hosted on CDP](https://portal.cdp-int.defra.cloud/services/waste-organisations) and has [supporting Redoc documentation](https://waste-organisations.api.dev.cdp-int.defra.cloud/redoc/index.html).

The [source code is available on Github](https://github.com/DEFRA/waste-organisations).

## Dev Credentials

### Authorisation Header

The API uses basic auth so you will need a `username` and `password` issued from [one of the maintainers](https://github.com/DEFRA/waste-organisations/graphs/contributors).

Given a username of `me` and a password of `password123`

1. create an authorization string: `me:password123`
2. convert to base64: `bWU6cGFzc3dvcmQxMjM=`
3. add to an authorization header `authorization: Basic bWU6cGFzc3dvcmQxMjM=`

**example of generating a base64 string with Node.js**
```
Buffer.from('me:password123').toString('base64')
```

### CDP API key

It's not possible to call the API directly from outside of CDP, so you will need to generate a CDP [Developer API Key](https://portal.cdp-int.defra.cloud/documentation/how-to/developer-api-key.md) which can be generated within [your profile](https://portal.cdp-int.defra.cloud/user-profile)

**n.b**

1. Developer API Keys have a limited lifespan (24 hours for dev)
2. You must access the service via an ephemeral protected API as detailed in the documentation.

### Example curl

Given a CDP Developer API key of 'let-me-in-123', and the details from above, an example curl could look like:

```
curl -v https://ephemeral.cdp.api/waste-organisations/organisations \
  -H "x-api-key: let-me-in-123" \
  -H "authorization: Basic bWU6cGFzc3dvcmQxMjM="
```

### Example Response

```
{
  organisations: [
    {
      "id": "cc994322-3403-4337-b135-669337cc752a",
      "name": "BETTWOOD DRIVE LIMITED",
      "tradingName": "CS_GENERATED_0145337_England",
      "businessCountry": "GB-ENG",
      "companiesHouseNumber": "CS_GENERATED_0145337",
      "address": {
        "addressLine1": "3",
        "addressLine2": "Lancaster Drive",
        "town": "Manchester",
        "county": null,
        "postcode": "M25 0HZ",
        "country": "England"
      },
      "registrations": [
        {
          "status": "REGISTERED",
          "type": "COMPLIANCE_SCHEME",
          "registrationYear": 2025
        }
      ]
    },
    ...
  ]
}
```
