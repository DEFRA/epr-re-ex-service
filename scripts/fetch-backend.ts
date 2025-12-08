import "dotenv/config";
import { BASE_DEV_URL } from "./constants.ts";

export const fetchBackend = async (
  path: string,
  method = "GET",
  payload: any,
): Promise<any> => {
  try {
    const url = `${BASE_DEV_URL}${path}`;

    const response = await fetch(url, {
      method,
      body: JSON.stringify(payload),
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (response.ok) {
      const json = await response.json();
      console.log("Success! 🎉\n\n");
      console.log("response", json);
      console.log("\n\nSuccess! 🎉");
      return json;
    } else {
      console.error("Response not ok ❌\n\n");
      const text = await response.text();
      console.log("text", text);
      console.error("\n\nResponse not ok ❌");
      throw new Error("Response not ok");
    }
  } catch (error) {
    console.error("Error thrown ❌\n\n");
    console.error("error", error);
  }
};
