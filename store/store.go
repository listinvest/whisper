package store

import (
	"errors"
	"time"
)

// Store represents a backend store.
type Store interface {
	Get(key string) ([]byte, error)
	Set(key string, value []byte) error
	Delete(key string) error
}

// Sess represents an authenticated peer session.
type Sess struct {
	PublicKey string    `json:"pk"`
	Since     time.Time `json:"since"`
}

// ErrRoomNotFound indicates that the requested room was not found.
var ErrRoomNotFound = errors.New("room not found")
