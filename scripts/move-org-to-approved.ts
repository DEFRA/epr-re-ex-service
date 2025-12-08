import "dotenv/config";
import { ORG_1_ID } from "./constants";

(async (): Promise<void> => {
  try {
    const payload = {
      organisation: {
        statusHistory: [
          {
            status: "created",
            updatedAt: "2025-10-01T08:30:00.000Z",
          },
          {
            status: "approved",
            updatedAt: new Date().toISOString(),
          },
        ],
      },
    };

    const url = `http://localhost:3001/v1/dev/organisations/${ORG_1_ID}`;
    const response = await fetch(url, {
      method: "PATCH",
      body: JSON.stringify(payload),
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      console.log("text", text);
      console.log("response.status", response.status);
      throw new Error("Response not ok");
    }

    const data = await response.json();
    console.log("Hooray!");
    console.log("data", data.organisation.statusHistory);
    console.log("data", data.organisation.status);
  } catch (error) {
    console.error("Fetching failed:", error);
  }
})();
