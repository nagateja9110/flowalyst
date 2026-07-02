#!/usr/bin/env python3
"""Deterministic e-commerce seed data: customers ⋈ orders ⋈ products.

Regenerate with:  python3 generate_seed.py
Also prints ground-truth answers used by server/eval/golden.json —
if you change this data, re-run and update the golden regexes.
"""
import csv
import random
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

random.seed(42)
HERE = Path(__file__).parent

CITIES = [
    ("Mumbai", "Maharashtra"), ("Delhi", "Delhi"), ("Bengaluru", "Karnataka"),
    ("Hyderabad", "Telangana"), ("Chennai", "Tamil Nadu"), ("Pune", "Maharashtra"),
    ("Kolkata", "West Bengal"), ("Coimbatore", "Tamil Nadu"),
]
FIRST = ["Aarav", "Vivaan", "Aditya", "Ananya", "Diya", "Ishaan", "Kavya", "Rohan",
         "Sneha", "Arjun", "Meera", "Karthik", "Priya", "Rahul", "Nisha", "Varun",
         "Pooja", "Sanjay", "Divya", "Amit"]
LAST = ["Sharma", "Patel", "Reddy", "Iyer", "Khan", "Nair", "Gupta", "Das",
        "Joshi", "Menon", "Bose", "Rao"]

PRODUCTS = [
    # (name, category, price)
    ("Wireless Earbuds", "Electronics", 2499), ("Smartwatch", "Electronics", 5999),
    ("Bluetooth Speaker", "Electronics", 1899), ("Power Bank 20000mAh", "Electronics", 1499),
    ("USB-C Cable", "Electronics", 299), ("Laptop Sleeve", "Electronics", 799),
    ("Running Shoes", "Sports", 3499), ("Yoga Mat", "Sports", 899),
    ("Cricket Bat", "Sports", 2799), ("Badminton Racket", "Sports", 1599),
    ("Cotton T-Shirt", "Fashion", 599), ("Denim Jeans", "Fashion", 1799),
    ("Leather Wallet", "Fashion", 999), ("Sneakers", "Fashion", 2299),
    ("Silk Saree", "Fashion", 4499), ("Mystery Novel", "Books", 349),
    ("Self-Help Bestseller", "Books", 449), ("Cookbook", "Books", 699),
    ("Air Fryer", "Home", 4999), ("Bedsheet Set", "Home", 1299),
    ("LED Desk Lamp", "Home", 899), ("Non-stick Pan", "Home", 1099),
    ("Wall Clock", "Home", 649), ("Coffee Maker", "Home", 3299),
]

N_CUSTOMERS = 60
N_ORDERS = 400
START = date(2025, 1, 1)

customers = []
for i in range(1, N_CUSTOMERS + 1):
    city, state = random.choice(CITIES)
    customers.append({
        "customer_id": i,
        "name": f"{random.choice(FIRST)} {random.choice(LAST)}",
        "city": city,
        "state": state,
        "age": random.randint(18, 60),
        "signup_date": (START + timedelta(days=random.randint(0, 180))).isoformat(),
    })

products = [
    {"product_id": i + 1, "product_name": n, "category": c, "price": p}
    for i, (n, c, p) in enumerate(PRODUCTS)
]

STATUSES = ["delivered"] * 8 + ["returned"] + ["cancelled"]
orders = []
for i in range(1, N_ORDERS + 1):
    p = random.choice(products)
    orders.append({
        "order_id": i,
        "customer_id": random.choice(customers)["customer_id"],
        "product_id": p["product_id"],
        "quantity": random.choice([1, 1, 1, 2, 2, 3]),
        "status": random.choice(STATUSES),
        "order_date": (START + timedelta(days=random.randint(0, 364))).isoformat(),
    })

def write(name, rows):
    with open(HERE / name, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=rows[0].keys())
        w.writeheader()
        w.writerows(rows)

write("customers.csv", customers)
write("products.csv", products)
write("orders.csv", orders)

# ---- ground truth for the eval golden set ----
price = {p["product_id"]: p["price"] for p in products}
cat = {p["product_id"]: p["category"] for p in products}
pname = {p["product_id"]: p["product_name"] for p in products}
cust = {c["customer_id"]: c for c in customers}
delivered = [o for o in orders if o["status"] == "delivered"]

def top(d):
    return max(d.items(), key=lambda kv: kv[1])

rev_city = defaultdict(float)
rev_cust = defaultdict(float)
rev_cat = defaultdict(float)
rev_prod = defaultdict(float)
units_cat = defaultdict(int)
rev_month = defaultdict(float)
for o in delivered:
    rev = o["quantity"] * price[o["product_id"]]
    rev_city[cust[o["customer_id"]]["city"]] += rev
    rev_cust[cust[o["customer_id"]]["name"]] += rev
    rev_cat[cat[o["product_id"]]] += rev
    rev_prod[pname[o["product_id"]]] += rev
    units_cat[cat[o["product_id"]]] += o["quantity"]
    rev_month[o["order_date"][:7]] += rev

returns = defaultdict(int)
totals = defaultdict(int)
for o in orders:
    totals[cat[o["product_id"]]] += 1
    if o["status"] == "returned":
        returns[cat[o["product_id"]]] += 1

print("top city by revenue:        ", top(rev_city))
print("top customer by spend:      ", top(rev_cust))
print("top category by revenue:    ", top(rev_cat))
print("top category by units:      ", top(units_cat))
print("top product by revenue:     ", top(rev_prod))
print("top month by revenue:       ", top(rev_month))
print("cancelled orders:           ", sum(1 for o in orders if o["status"] == "cancelled"))
print("customers in Mumbai:        ", sum(1 for c in customers if c["city"] == "Mumbai"))
print("highest return-rate category:", top({c: returns[c] / totals[c] for c in totals}))
