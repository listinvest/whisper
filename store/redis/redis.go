package redis

import (
	"time"

	"github.com/gomodule/redigo/redis"
)

// Config represents the Redis store config structure.
type Config struct {
	Address     string        `koanf:"address"`
	Password    string        `koanf:"password"`
	DB          int           `koanf:"db"`
	ActiveConns int           `koanf:"active_conns"`
	IdleConns   int           `koanf:"idle_conns"`
	Timeout     time.Duration `koanf:"timeout"`

	PrefixRoom    string `koanf:"prefix_room"`
	PrefixSession string `koanf:"prefix_session"`
}

// Redis represents the Redis implementation of the Store interface.
type Redis struct {
	cfg  *Config
	pool *redis.Pool
}

type room struct {
	ID        string `redis:"id"`
	Name      string `redis:"name"`
	Password  []byte `redis:"password"`
	CreatedAt string `redis:"created_at"`
}

// New returns a new Redis store.
func New(cfg Config) (*Redis, error) {
	pool := &redis.Pool{
		Wait:      true,
		MaxActive: cfg.ActiveConns,
		MaxIdle:   cfg.IdleConns,
		Dial: func() (redis.Conn, error) {
			return redis.Dial(
				"tcp",
				cfg.Address,
				redis.DialPassword(cfg.Password),
				redis.DialConnectTimeout(cfg.Timeout),
				redis.DialReadTimeout(cfg.Timeout),
				redis.DialWriteTimeout(cfg.Timeout),
				redis.DialDatabase(cfg.DB),
			)
		},
	}

	// Test connection.
	c := pool.Get()
	defer c.Close()

	if err := c.Err(); err != nil {
		return nil, err
	}
	return &Redis{cfg: &cfg, pool: pool}, nil
}

// Get value from a key.
func (r *Redis) Get(key string) ([]byte, error) {
	c := r.pool.Get()
	defer c.Close()
	return redis.Bytes(c.Do("GET", key))
}

// Set a value.
func (r *Redis) Set(key string, data []byte) error {
	c := r.pool.Get()
	defer c.Close()
	_, err := c.Do("SET", key, data)
	return err
}

// Delete a value.
func (r *Redis) Delete(key string) error {
	c := r.pool.Get()
	defer c.Close()
	_, err := c.Do("DEL", key)
	return err
}
