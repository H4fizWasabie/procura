package auth

import (
	"crypto/rand"
	"database/sql"
	"math/big"
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

	return issueToken(email, role, name)
}

// DemoLogin issues a read-only VIEWER token without credentials. No DB row needed.
func (s *Service) DemoLogin() (string, *Claims, error) {
	return issueToken("demo@procura.app", "VIEWER", "Demo User")
}

func issueToken(email, role, name string) (string, *Claims, error) {
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
		// VIEWER = read-only: block every non-GET except read-only/self-service POSTs
		if claims.Role == "VIEWER" && r.Method != http.MethodGet &&
			r.URL.Path != "/api/reports/item-history" && r.URL.Path != "/api/change-pin" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			w.Write([]byte(`{"error":"Demo account is read-only"}`))
			return
		}
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

// BootstrapAdmin creates an admin user if no users exist. Returns the generated PIN.
func (s *Service) BootstrapAdmin() string {
	var count int
	s.DB.QueryRow("SELECT COUNT(*) FROM users").Scan(&count)
	if count > 0 {
		return ""
	}
	pin := randomPIN(6)
	hash, _ := bcrypt.GenerateFromPassword([]byte(pin), bcrypt.DefaultCost)
	s.DB.Exec("INSERT INTO users (email, role, name, pin_hash, must_change_pin) VALUES (?, 'ADMIN', 'Hafiz', ?, 1)",
		"kisame350@gmail.com", string(hash))
	return pin
}

func randomPIN(n int) string {
	p := make([]byte, n)
	for i := range p {
		r, _ := rand.Int(rand.Reader, big.NewInt(10))
		p[i] = byte('0' + r.Int64())
	}
	return string(p)
}

type apiError struct{ msg string }

func (e *apiError) Error() string { return e.msg }

func fmtError(msg string) error { return &apiError{msg} }

// ── User CRUD ──

type UserRecord struct {
	Email         string `json:"email"`
	Name          string `json:"name"`
	Role          string `json:"role"`
	LastAccess    string `json:"lastAccess"`
	MustChangePIN bool   `json:"mustChangePin"`
}

func (s *Service) ListUsers() []UserRecord {
	rows, err := s.DB.Query("SELECT email, name, role, last_access, must_change_pin FROM users ORDER BY email")
	if err != nil {
		return nil
	}
	defer rows.Close()
	var users []UserRecord
	for rows.Next() {
		var u UserRecord
		var last sql.NullString
		var must int
		rows.Scan(&u.Email, &u.Name, &u.Role, &last, &must)
		if last.Valid {
			u.LastAccess = last.String
		}
		u.MustChangePIN = must != 0
		users = append(users, u)
	}
	return users
}

func (s *Service) AddUser(email, name, role string) (string, error) {
	email = strings.TrimSpace(strings.ToLower(email))
	if email == "" || name == "" {
		return "", fmtError("Email and name required")
	}
	pin := randomPIN(6)
	hash, _ := bcrypt.GenerateFromPassword([]byte(pin), bcrypt.DefaultCost)
	_, err := s.DB.Exec("INSERT INTO users (email, name, role, pin_hash, must_change_pin) VALUES (?, ?, ?, ?, 1)",
		email, name, role, string(hash))
	if err != nil {
		return "", fmtError("Email already exists")
	}
	return pin, nil
}

func (s *Service) UpdateUser(email, name, role string) error {
	_, err := s.DB.Exec("UPDATE users SET name = ?, role = ? WHERE email = ?", name, role, email)
	return err
}

func (s *Service) ResetUserPIN(email string) (string, error) {
	pin := randomPIN(6)
	hash, _ := bcrypt.GenerateFromPassword([]byte(pin), bcrypt.DefaultCost)
	res, err := s.DB.Exec("UPDATE users SET pin_hash = ?, must_change_pin = 1 WHERE email = ?", string(hash), email)
	if err != nil {
		return "", err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return "", fmtError("User not found")
	}
	return pin, nil
}

func (s *Service) DeleteUser(email string) error {
	res, _ := s.DB.Exec("DELETE FROM users WHERE email = ?", email)
	if n, _ := res.RowsAffected(); n == 0 {
		return fmtError("User not found")
	}
	return nil
}
