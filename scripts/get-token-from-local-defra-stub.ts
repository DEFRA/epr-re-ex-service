import "dotenv/config";

(async (): Promise<void> => {
  try {
    const payload = {
      userId: "86a7607c-a1e7-41e5-a0b6-a41680d05a2a",
      email: "some@example.com",
      firstName: "John",
      lastName: "Doe",
      loa: "1",
      aal: "1",
      enrolmentCount: 1,
      enrolmentRequestCount: 1,
      relationships: [
        {
          organisationName: "Some Org",
          relationshipRole: "Employee",
          roleName: "Some role",
          roleStatus: "1",
        },
      ],
    };

    const registerUrl =
      "https://cdp-defra-id-stub.dev.cdp-int.defra.cloud/cdp-defra-id-stub/API/register";
    const response = await fetch(registerUrl, {
      method: "POST",
      body: JSON.stringify(payload),
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      console.log("response.status", response.status);
      throw new Error("Response not ok");
    }

    const data = await response.json();
    console.log("data", data);

    // // Extract data
    // const title: string | null = await page.locator("h1").textContent();
    // const links: string[] = await page.locator("a").allTextContents();
    //
    // // Output (e.g., JSON)
    // const data: ScrapedData = { title: title || "", links };
    // console.log(data);
    //
    // // Save to file
    // fs.writeFileSync("data.json", JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("Fetching failed:", error);
  }
})();
