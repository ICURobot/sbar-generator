import os
import sys
from libsql_experimental import connect
from dotenv import load_dotenv

load_dotenv()

TURSO_DATABASE_URL = os.getenv("TURSO_DATABASE_URL")
TURSO_AUTH_TOKEN = os.getenv("TURSO_AUTH_TOKEN")

if not TURSO_DATABASE_URL or not TURSO_AUTH_TOKEN:
    print("Error: Missing Turso credentials")
    sys.exit(1)

def verify_content():
    print("Connecting to database...")
    client = connect(TURSO_DATABASE_URL, auth_token=TURSO_AUTH_TOKEN)
    cursor = client.cursor()
    
    # 1. List all books to get exact title
    print("\n📚 Books in database:")
    cursor.execute("SELECT DISTINCT book_title FROM medical_knowledge")
    books = cursor.fetchall()
    target_book = None
    for book in books:
        print(f" - {book[0]}")
        if "Canadian Lab Test Manual" in book[0]:
            target_book = book[0]
            
    if not target_book:
        print("\n❌ 'Canadian Lab Test Manual' book not found in database!")
        return

    print(f"\n🔍 Searching in book: '{target_book}'")
    
    # 2. Search for keywords via SQL LIKE
    keywords = ["Potassium", "Sodium", "Calcium", "Normal range"]
    
    for keyword in keywords:
        print(f"\nChecking for '{keyword}'...")
        cursor.execute(
            "SELECT COUNT(*), chunk_text FROM medical_knowledge WHERE book_title = ? AND chunk_text LIKE ? LIMIT 3", 
            (target_book, f"%{keyword}%")
        )
        result = cursor.fetchone()
        count = result[0] if result else 0
        print(f"   Found {count} chunks containing '{keyword}'")
        
        if count > 0:
            print(f"   Sample chunk: {result[1][:200]}...")

    # 3. Check total chunks for this book
    cursor.execute("SELECT COUNT(*) FROM medical_knowledge WHERE book_title = ?", (target_book,))
    total_chunks = cursor.fetchone()[0]
    print(f"\nTotal chunks for '{target_book}': {total_chunks}")

if __name__ == "__main__":
    verify_content()
