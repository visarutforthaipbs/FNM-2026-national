import pandas as pd
import time
import random
import os
import undetected_chromedriver as uc
from selenium.webdriver.common.by import By
import re

def setup_driver():
    options = uc.ChromeOptions()
    # options.add_argument("--headless") # Headless often gets caught easier
    
    # Initialize the undetected driver
    driver = uc.Chrome(options=options)
    return driver

def search_dataforthai(driver, company_name):
    print(f"🔍 Searching for: {company_name}")
    try:
        # Go to search page
        driver.get(f"https://www.dataforthai.com/search?q={company_name}")
        
        # Initial wait for Cloudflare/Page load
        # If you see a verification box, please click it in the browser window
        time.sleep(random.uniform(5, 8)) 
        
        # Look for the 13-digit ID
        page_source = driver.page_source
        
        # 1. Try to find IDs in links (/business/0123456789012)
        ids_in_links = re.findall(r'/business/(\d{13})', page_source)
        
        # 2. Try to find 13-digit numbers in the visible text
        try:
            body_text = driver.find_element(By.TAG_NAME, "body").text
            ids_in_text = re.findall(r'\b\d{13}\b', body_text)
        except:
            ids_in_text = []
        
        all_found_ids = list(set(ids_in_links + ids_in_text))
        
        if all_found_ids:
            juristic_id = all_found_ids[0]
            print(f"  ✅ Found Juristic ID: {juristic_id}")
            return {
                "juristic_id": juristic_id,
                "url": f"https://www.dataforthai.com/business/{juristic_id}"
            }
        else:
            # Check if we are stuck on a challenge page
            if "security verification" in page_source.lower() or "not a bot" in page_source.lower():
                print("  🛑 Stuck on Cloudflare verification. Please solve it in the browser window!")
                time.sleep(15) # Give user time to solve
            else:
                print("  ❌ No Juristic ID found in results.")
            return None
            
    except Exception as e:
        print(f"  ⚠️ Error during search: {e}")
        return None

def run_enrichment(input_csv, output_csv, batch_limit=10):
    if not os.path.exists(input_csv):
        print(f"Error: {input_csv} not found.")
        return

    df = pd.read_csv(input_csv)
    to_process = df.head(batch_limit)
    
    print("🚀 Launching Undetected Chrome...")
    driver = setup_driver()
    results = []

    try:
        # Initial visit to set cookies and handle first challenge
        print("🏠 Visiting home page to initialize...")
        driver.get("https://www.dataforthai.com/")
        time.sleep(10) # ⏳ WAIT HERE: Solve the first Cloudflare challenge if it appears
        
        for idx, row in to_process.iterrows():
            name = row['name']
            data = search_dataforthai(driver, name)
            
            row_result = row.to_dict()
            if data:
                row_result.update(data)
            else:
                row_result['juristic_id'] = None
                row_result['url'] = None
                
            results.append(row_result)
            
            wait_time = random.uniform(8, 15)
            print(f"      Waiting {wait_time:.2f}s before next search...")
            time.sleep(wait_time)

        # Save results
        enriched_df = pd.DataFrame(results)
        enriched_df.to_csv(output_csv, index=False, encoding='utf-8-sig')
        print(f"\n✨ Batch complete! Saved {len(results)} records to {output_csv}")

    finally:
        driver.quit()

if __name__ == "__main__":
    INPUT = "active_factories_for_dbd_match.csv"
    OUTPUT = "enriched_factories_sample.csv"
    LIMIT = 5 
    
    run_enrichment(INPUT, OUTPUT, LIMIT)
