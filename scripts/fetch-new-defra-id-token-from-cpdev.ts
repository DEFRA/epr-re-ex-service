import { chromium, Browser, Page } from "playwright";
import "dotenv/config";
import fs from "fs";

(async (): Promise<void> => {
  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({ headless: true }); // Headless for efficiency
    const page: Page = await browser.newPage();

    console.log("Navigating to frontend");
    // Navigate
    await page.goto("https://epr-frontend.dev.cdp-int.defra.cloud");

    // Wait for page to load and check title
    await page.waitForLoadState("domcontentloaded");
    const title = await page.title();
    if (!title.match(/Home/i)) {
      throw new Error(`Expected title to contain "Home", but got: ${title}`);
    }

    console.log("Starting sign in");
    // Click the "Start now" button
    await page.getByRole("button", { name: /Start now/i }).click();

    await page.waitForTimeout(5000);

    const title2 = await page.title();
    if (!title2.match(/Create your/i)) {
      throw new Error(
        `Expected title to contain "Create your", but got: ${title}`,
      );
    }

    console.log("Click sign in");
    // Click the "Start now" button
    await page.getByRole("button", { name: /Sign in/i }).click();

    await page.waitForLoadState("domcontentloaded");

    const title3 = await page.title();
    if (!title3.match(/Enter your email/i)) {
      throw new Error(
        `Expected title to contain "Enter your email address", but got: ${title}`,
      );
    }

    console.log("Entering email");
    // Type password into the email address input field
    await page.locator("#email").fill(process.env.EMAIL_ADDRESS || "");

    await page.getByRole("button", { name: /Continue/i }).click();

    await page.waitForLoadState("domcontentloaded");

    console.log("Entering password");
    // Type password into the email address input field
    await page.locator("#password").fill(process.env.PASSWORD || "");

    await page.getByRole("button", { name: /Continue/i }).click();

    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(5000);

    console.log("Signed in to Welcome page");
    // Check that the page contains "Welcome"
    const pageContent = await page.textContent("body");
    if (!pageContent?.match(/Welcome/i)) {
      throw new Error(
        `Expected page to contain "Welcome", but it was not found`,
      );
    }

    console.log("Successfully reached Welcome page!");

    // Expand the accordion to view account details
    await page.locator("summary.govuk-details__summary").click();

    // Wait for the summary list to appear
    await page.waitForSelector(".govuk-summary-list__row");
    console.log("Obtaining user details");

    // Extract the idToken value from the summary list
    const rows = await page.locator(".govuk-summary-list__row").all();
    let idToken: string | null = null;

    for (const row of rows) {
      const key = await row.locator("dt.govuk-summary-list__key").textContent();
      if (key?.trim() === "idToken") {
        const valueElement = row.locator("dd.govuk-summary-list__value");
        idToken = await valueElement.textContent();
        break;
      }
    }

    if (!idToken) {
      throw new Error("Could not find idToken in the table");
    }

    const sanitizedIdToken = idToken.trim();

    console.log("Replacing token in .env");

    // Update TOKEN in .env file
    const envPath = ".env";
    const envContent = fs.readFileSync(envPath, "utf-8");

    const tokenRegex = /^TOKEN=.*$/m;
    let updatedContent: string;

    if (tokenRegex.test(envContent)) {
      // Replace existing TOKEN value
      updatedContent = envContent.replace(
        tokenRegex,
        `TOKEN=${sanitizedIdToken}`,
      );
    } else {
      // Append TOKEN if it doesn't exist
      updatedContent =
        envContent +
        (envContent.endsWith("\n") ? "" : "\n") +
        `TOKEN=${sanitizedIdToken}\n`;
    }

    fs.writeFileSync(envPath, updatedContent, "utf-8");
    console.log("Updated TOKEN in .env file");
  } catch (error) {
    console.error("Scraping failed:", error);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
})();
