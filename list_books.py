import os
from libsql_experimental import connect
from dotenv import load_dotenv

load_dotenv()

def list_vectorized_books():
    url = os.getenv("TURSO_DATABASE_URL")
    token = os.getenv("TURSO_AUTH_TOKEN")
    
    if not url or not token:
        print("Error: Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN")
        return

    try:
        conn = connect(url, auth_token=token)
        cursor = conn.cursor()
        
        # Check if table exists
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='medical_knowledge'")
        if not cursor.fetchone():
            print("Table 'medical_knowledge' does not exist yet.")
            return

        # Query distinct book titles
        cursor.execute("SELECT DISTINCT book_title, source_file, COUNT(*) as chunks FROM medical_knowledge GROUP BY book_title, source_file")
        rows = cursor.fetchall()
        
        if not rows:
            print("No books found in the database.")
            return

        print(f"Found {len(rows)} book(s) in the database:")
        print("-" * 80)
        print(f"{'Book Title':<40} | {'Source File':<30} | {'Chunks':<10}")
        print("-" * 80)
        for row in rows:
            title = row[0] or "N/A"
            source = row[1] or "N/A"
            chunks = row[2]
            print(f"{title[:40]:<40} | {source[:30]:<30} | {chunks:<10}")
            
    except Exception as e:
        print(f"Error querying database: {e}")

if __name__ == "__main__":
    list_vectorized_books()
