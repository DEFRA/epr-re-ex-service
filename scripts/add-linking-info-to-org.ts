import { fetchBackend } from "./fetch-backend.ts";

(async (): Promise<void> => {
  const payload = {
    organisation: {
      linkedDefraOrganisation: {
        orgId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
        orgName: "bbbbbbbbbbbb",
        linkedBy: {
          email: "carles@me.com",
          id: "f6e5d4c3-b2a1-4f5e-9d8c-7b6a5f4e3d2c",
        },
        linkedAt: new Date(),
      },
    },
  };

  await fetchBackend(
    "/organisations/6507f1f77bcf86cd79943901",
    "PATCH",
    payload,
  );
})();
