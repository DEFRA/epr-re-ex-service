import "dotenv/config";

(async (): Promise<void> => {
  try {
    const token = process.env.TOKEN;

    if (!token) {
      throw new Error("TOKEN not found in .env file");
    }

    // JWT tokens have 3 parts separated by dots: header.payload.signature
    const parts = token.split(".");

    if (parts.length !== 3) {
      throw new Error("Invalid JWT token format");
    }

    // Decode the payload (middle part)
    const payload = parts[1];

    // Base64 URL decode
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const jsonPayload = Buffer.from(base64, "base64").toString("utf-8");

    // Parse JSON
    const decoded = JSON.parse(jsonPayload);

    console.log("token payload:", decoded);
  } catch (error) {
    console.error("Decoding failed:", error);
  }
})();
