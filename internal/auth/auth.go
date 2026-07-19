package auth

import (
	"database/sql"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

var jwtSecret = []byte("procura-secret-change-in-production")

type Claims struct {
	Email string `json:"email"`
	Role  string `json:"role"`
	Name  string `json:"name"`
	jwt.RegisteredClaims
}

type attempt struct {
	count    int
	lockedUntil time.Time
}

var (
	mu       sync.Mutex
	attempts = map[string]*attempt{}
)

type Service struct {
	DB *sql.DB
}

// Login authenticates user and returns JWT.
func (s *Service) Login(email, pin string) (string, *Claims, error) {
	email = strings.TrimSpace(strings.ToLower(email))

	mu.Lock()
	a := attempts[email]
	if a != nil && time.Now().Before(a.lockedUntil) {
		remaining := a.lockedUntil.Sub(time.Now()).Round(time.Minute)
		mu.Unlock()
		return "", nil, fmtError("Account locked. Try again in " + remaining.String())
	}
	mu.Unlock()

	var storedHash, role, name string
	var mustChange int
	err := s.DB.QueryRow(
		"SELECT pin_hash, role, name, must_change_pin FROM users WHERE email = ?",
		email,
	).Scan(&storedHash, &role, &name, &mustChange)
	if err != nil {
		s.recordFailure(email)
		return "", nil, fmtError("Invalid credentials")
	}

	if err := bcrypt.CompareHashAndPassword([]byte(storedHash), []byte(pin)); err != nil {
		s.recordFailure(email)
		return "", nil, fmtError("Invalid credentials")
	}

	// Success: clear attempts
	mu.Lock()
	delete(attempts, email)
	mu.Unlock()

	// Update last access
	s.DB.Exec("UPDATE users SET last_access = ? WHERE email = ?", time.Now().Format(time.RFC3339), email)

	claims := &Claims{
		Email: email,
		Role:  role,
		Name:  name,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(8 * time.Hour)),
		},
	}

	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(jwtSecret)
	return token, claims, err
}

// MustChangePIN returns true if user must change their PIN.
func (s *Service) MustChangePIN(email string) bool {
	var must int
	s.DB.QueryRow("SELECT must_change_pin FROM users WHERE email = ?", email).Scan(&must)
	return must != 0
}

// ChangePIN updates a user's PIN.
func (s *Service) ChangePIN(email, oldPin, newPin string) error {
	var hash string
	s.DB.QueryRow("SELECT pin_hash FROM users WHERE email = ?", email).Scan(&hash)
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(oldPin)) != nil {
		return fmtError("Incorrect current PIN")
	}
	if len(newPin) < 6 {
		return fmtError("New PIN must be at least 6 digits")
	}
	newHash, _ := bcrypt.GenerateFromPassword([]byte(newPin), bcrypt.DefaultCost)
	_, err := s.DB.Exec("UPDATE users SET pin_hash = ?, must_change_pin = 0 WHERE email = ?", string(newHash), email)
	return err
}

// Middleware wraps a handler with JWT verification. Sets user info in context.
func (s *Service) Middleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cookie, _ := r.Cookie("token")
		tokenStr := ""
		if cookie != nil {
			tokenStr = cookie.Value
		} else if ah := r.Header.Get("Authorization"); strings.HasPrefix(ah, "Bearer ") {
			tokenStr = ah[7:]
		}
		if tokenStr == "" {
			http.Redirect(w, r, "/login", http.StatusSeeOther)
			return
		}
		claims := &Claims{}
		token, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (interface{}, error) { return jwtSecret, nil })
		if err != nil || !token.Valid {
			http.Redirect(w, r, "/login", http.StatusSeeOther)
			return
		}
		// Store claims in context via header for simplicity
		r.Header.Set("X-User-Email", claims.Email)
		r.Header.Set("X-User-Role", claims.Role)
		r.Header.Set("X-User-Name", claims.Name)
		next(w, r)
	}
}

// RequireRole returns middleware that checks for specific roles.
func RequireRole(roles ...string) func(http.HandlerFunc) http.HandlerFunc {
	return func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			role := r.Header.Get("X-User-Role")
			for _, allowed := range roles {
				if role == allowed {
					next(w, r)
					return
				}
			}
			http.Error(w, "Forbidden", http.StatusForbidden)
		}
	}
}

func (s *Service) recordFailure(email string) {
	mu.Lock()
	defer mu.Unlock()
	a := attempts[email]
	if a == nil {
		a = &attempt{}
		attempts[email] = a
	}
	a.count++
	if a.count >= 3 {
		tiers := []time.Duration{5, 15, 60}
		tier := min(a.count-3, len(tiers)-1)
		a.lockedUntil = time.Now().Add(tiers[tier] * time.Minute)
	}
}

// CreateTestUser bootstraps an admin user if no users exist.
func (s *Service) CreateTestUser() {
	var count int
	s.DB.QueryRow("SELECT COUNT(*) FROM users").Scan(&count)
	if count == 0 {
		hash, _ := bcrypt.GenerateFromPassword([]byte("000000"), bcrypt.DefaultCost)
		s.DB.Exec("INSERT INTO users (email, role, name, pin_hash) VALUES (?, 'ADMIN', 'Admin', ?)",
			"admin@procura.local", string(hash))
	}
}

type apiError struct{ msg string }

func (e *apiError) Error() string { return e.msg }

func fmtError(msg string) error { return &apiError{msg} }
