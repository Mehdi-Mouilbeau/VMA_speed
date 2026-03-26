#!/usr/bin/env python3
"""
Récupère le token Garmin Connect pour l'utiliser dans vma-speed.netlify.app
"""
import sys, getpass

try:
    import garth
except ImportError:
    import os
    os.system(f"{sys.executable} -m pip install garth")
    import garth

try:
    garth.load("~/.garth")
    if garth.client.oauth2_token.expired:
        garth.client.refresh_oauth2()
        garth.dump("~/.garth")
    token = garth.client.oauth2_token.access_token
    print("\n✅ Token récupéré depuis ~/.garth\n")
except Exception:
    print("Connexion à Garmin Connect...")
    email    = input("Email    : ").strip()
    password = getpass.getpass("Mot de passe : ")
    try:
        garth.login(email, password)
        garth.dump("~/.garth")
        token = garth.client.oauth2_token.access_token
        print("\n✅ Connecté\n")
    except Exception as e:
        print(f"\n❌ Erreur : {e}")
        sys.exit(1)

print("Copie ce token dans l'application :")
print("─" * 60)
print(token)
print("─" * 60)
print()
