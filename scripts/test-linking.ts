import { ORG_1_ID } from "./constants";
import { fetchBackend } from "./fetch-backend.ts";

(async (): Promise<void> => {
  const payload = {
    organisation: {
      users: [
        {
          fullName: "Luke Skywalker",
          email: "anakin.skywalker@starwars.com",
          isInitialUser: true,
          roles: ["standard_user"],
        },
        {
          email: "carles.andres@defra.gov.uk",
          fullName: "Carles Test",
          isInitialUser: true,
          roles: ["standard_user"],
        },
      ],
    },
  };

  const data = await fetchBackend(
    `/organisations/${ORG_1_ID}/link`,
    "POST",
    null,
  );
  console.log("data", data);
})();
