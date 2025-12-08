import { ORG_1_ID } from "./constants";
import { fetchBackend } from "./fetch-backend.ts";

(async (): Promise<void> => {
  const payload = {
    organisation: {
      users: [
        {
          email: "saul.goodman@bettercall.com",
          fullName: "Saul Goodman",
          isInitialUser: true,
          roles: ["standard_user"],
        },
      ],
    },
  };

  const data = await fetchBackend(
    `/organisations/${ORG_1_ID}`,
    "PATCH",
    payload,
  );
  console.log("data.organisations.users", data.organisation.users);
})();
