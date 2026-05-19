from apps.core.sanitizers import sanitize_text, sanitize_username

def test():
    print("Testing final sanitization logic (simple)...")

    # Test sanitize_username
    try:
        u = sanitize_username("  user_name123  ")
        print(f"Username cleaned: '{u}'")
        if u != "user_name123":
            print("FAILED: Username not cleaned correctly")

        try:
            sanitize_username("ab")
            print("FAILED: username too short not caught")
        except Exception as e:
            print(f"SUCCESS: username too short caught: {e}")

    except Exception as e:
        print(f"Error during username test: {e}")

    # Test sanitize_text
    try:
        t = sanitize_text("<p>Hello <b>World</b></p>")
        print(f"Text cleaned: '{t}'")
        if t != "Hello World":
            print("FAILED: Text not cleaned correctly")
    except Exception as e:
        print(f"Error during text test: {e}")

if __name__ == "__main__":
    test()
