# Tools for testing end-to-end journeys

## Fetch a Defra Id token (from CPDev)

CDPev is Defra Id's dev environment.

To get a token for testing:

1. Create an `.env` file with your CDPev credentials:

   ```bash
   EMAIL_ADDRESS=your-username
   PASSWORD=your-password
   ```
2. Run `bun fetch-new-defra-id-token-from-cpdev`.

A playwright script will log into CPDEv for you an extract the token from our `epr-frontend` app.

If a token can be fetch it will be appended as a new `TOKEN` env var in the same `.env` file.

A CDPDev token expires every 30 minutes, so you will need to renew it regularly by calling the script again regularly.


## Running your backend locally

Run your backend on port 3001. Or change the expected hostname in
   `constants.ts` before you attempt to run any other scripts.

## To test that the token works to access protected endpoints

```bash
bun test-auth-with-saved-token.ts
```


## To test adding a new user to the organisation

```bash
bun add-my-user.ts
```


## To test linking an organisation (linking endpoint)

```bash
bun test-linking.ts
```
