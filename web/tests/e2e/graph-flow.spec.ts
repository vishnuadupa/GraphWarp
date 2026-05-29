import { test, expect } from '@playwright/test';

test.describe('GraphWarp E2E Flow', () => {
  test('should load the landing page and have a Theme Toggle', async ({ page }) => {
    await page.goto('/');
    
    // Check that the title is correct
    await expect(page).toHaveTitle(/GraphWarp/);
    
    // Check for theme toggle
    const themeToggle = page.locator('button[aria-label="Toggle Dark Mode"]').first();
    await expect(themeToggle).toBeVisible();

    // Toggle theme
    await themeToggle.click();
    
    // We expect the html element to eventually get the 'dark' or 'light' class
    await expect(page.locator('html')).toHaveClass(/(dark|light)/);
  });

  test('should navigate to login page', async ({ page }) => {
    await page.goto('/');
    await page.click('text=Log in');
    await expect(page).toHaveURL(/.*login/);
    await expect(page.locator('h1')).toContainText('Sign in to GraphWarp');
  });
});
