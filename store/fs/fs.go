package fs

import (
	"encoding/json"
	"fmt"
	"io/ioutil"
	"log"
	"os"
	"sync"
	"time"
)

// Config represents the file store config structure.
type Config struct {
	Path string `koanf:"path"`
}

// File represents the file implementation of the Store interface.
type File struct {
	cfg   *Config
	data  map[string][]byte
	mu    sync.Mutex
	dirty bool
	log   *log.Logger
}

// New returns a new Redis store.
func New(cfg Config, log *log.Logger) (*File, error) {
	store := &File{
		cfg:  &cfg,
		data: map[string][]byte{},
		log:  log,
	}
	err := store.load()
	go store.watch()
	return store, err
}

// watch the store to clean it up.
func (m *File) watch() {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for range t.C {
		m.cleanup()
		m.save()
	}
}

// cleanup the store to removes expired items.
func (m *File) cleanup() {
	// m.mu.Lock()
	// defer m.mu.Unlock()
	//
	// now := time.Now()

}

// load the data from the file system.
func (m *File) load() error {
	if _, err := os.Stat(m.cfg.Path); err == nil {
		x := struct {
			Data map[string][]byte
		}{}
		var data []byte
		data, err = ioutil.ReadFile(m.cfg.Path)
		if err != nil {
			return err
		}
		err = json.Unmarshal(data, &x)
		if err != nil {
			return err
		}
		m.data = x.Data
	}
	return nil
}

// save the data to the file system.
func (m *File) save() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.dirty {
		data, err := json.Marshal(struct {
			Data map[string][]byte
		}{
			Data: m.data,
		})
		if err == nil {
			m.dirty = false
			err = ioutil.WriteFile(m.cfg.Path, data, os.ModePerm)
			if err != nil {
				m.log.Printf("error writing file %q: %v", m.cfg.Path, err)
			}
		}
		return err
	}
	return nil
}

// Close and save the data to the file system.
func (m *File) Close() error {
	return m.save()
}

// Get value from a key.
func (m *File) Get(key string) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d, ok := m.data[key]
	if !ok {
		return nil, fmt.Errorf("key %q not found", key)
	}
	return d, nil
}

// Set a value.
func (m *File) Set(key string, data []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.data[key] = make([]byte, len(data), len(data))
	copy(m.data[key], data)
	m.dirty = true
	return nil
}

// Delete a value.
func (m *File) Delete(key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.data, key)
	m.dirty = true
	return nil
}
