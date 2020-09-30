package mem

import (
	"fmt"
	"sync"
	"time"
)

// Config represents the InMemory store config structure.
type Config struct{}

// InMemory represents the in-memory implementation of the Store interface.
type InMemory struct {
	cfg  *Config
	data map[string][]byte
	mu   sync.Mutex
}

// New returns a new Redis store.
func New(cfg Config) (*InMemory, error) {
	store := &InMemory{
		cfg:  &cfg,
		data: map[string][]byte{},
	}
	go store.watch()
	return store, nil
}

// watch the store to clean it up.
func (m *InMemory) watch() {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for range t.C {
		m.cleanup()
	}
}

// cleanup the store to removes expired items.
func (m *InMemory) cleanup() {
	// m.mu.Lock()
	// defer m.mu.Unlock()
	//
	// now := time.Now()

}

// Get value from a key.
func (m *InMemory) Get(key string) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d, ok := m.data[key]
	if !ok {
		return nil, fmt.Errorf("key %q not found", key)
	}
	return d, nil
}

// Set a value.
func (m *InMemory) Set(key string, data []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.data[key] = make([]byte, len(data), len(data))
	copy(m.data[key], data)
	return nil
}

// Delete a value.
func (m *InMemory) Delete(key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.data, key)
	return nil
}
