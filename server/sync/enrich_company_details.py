import pandas as pd
import requests
from bs4 import BeautifulSoup
import time
import os
import sys

def search_company_id(name):
    """
    Try to find the 13-digit Juristic ID for a company name on dataforthai.com
    Note: This is a demonstration and may be blocked by anti-bot measures.
    """
    search_url = f"https://www.dataforthai.com/search?q={name}"
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    }
    
    try:
        response = requests.get(search_url, headers=headers, timeout=10)
        if response.status_code == 200:
            soup = BeautifulSoup(response.text, 'html.parser')
            # Look for 13-digit IDs in links or text
            # This is a placeholder for actual parsing logic which depends on the site structure
            import re
            ids = re.findall(r'\b\d{13}\b', response.text)
            if ids:
                return ids[0]
    except Exception as e:
        print(f"Error searching for {name}: {e}")
    return None

def enrich_data(input_file, limit=10):
    print(f"Reading {input_file}...")
    df = pd.read_csv(input_file)
    
    # Take a sample for demonstration
    sample_df = df.head(limit).copy()
    
    print(f"Enriching {limit} records (sample)...")
    results = []
    
    for idx, row in sample_df.iterrows():
        name = row['name']
        print(f"Searching for: {name}")
        juristic_id = search_company_id(name)
        
        if juristic_id:
            print(f"  Found ID: {juristic_id}")
            # Here you would fetch details from https://www.dataforthai.com/business/{juristic_id}
            results.append({'name': name, 'juristic_id': juristic_id})
        else:
            print(f"  ID not found.")
            results.append({'name': name, 'juristic_id': None})
            
        # Be nice to the server
        time.sleep(2)
        
    enrichment_df = pd.DataFrame(results)
    print("\n--- Results ---")
    print(enrichment_df)

if __name__ == "__main__":
    enrich_data("active_factories_for_dbd_match.csv", limit=5)
