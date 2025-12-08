import "dotenv/config";
import { BACKEND_URL } from "./constants.ts";

(async (): Promise<void> => {
  try {
    const response = await fetch(`${BACKEND_URL}/organisations`, {
      headers: {
        Authorization: `Bearer ${process.env.TOKEN}`,
      },
    });

    if (response.ok) {
      console.log("Success! 🎉");
    } else {
      const responseText = await response.text();
      console.log("responseText", responseText);
      throw new Error("Response not ok");
    }

    const data = await response.json();

    console.log("data", data);

    console.log("Yay!");
  } catch (error) {
    console.error("Fetching failed:", error);
  }
})();
