package runner

const ProtocolVersion = 1

type Request struct {
	Version       int               `json:"version"`
	StatePath     string            `json:"state_path,omitempty"`
	Mode          string            `json:"mode,omitempty"`
	Network       bool              `json:"network,omitempty"`
	Command       string            `json:"command"`
	Args          []string          `json:"args,omitempty"`
	Cwd           string            `json:"cwd"`
	Env           map[string]string `json:"env,omitempty"`
	TimeoutMS     uint32            `json:"timeout_ms,omitempty"`
	Child         bool              `json:"child,omitempty"`
	SandboxSID    string            `json:"sandbox_sid,omitempty"`
	ResultPath    string            `json:"result_path,omitempty"`
	Desktop       string            `json:"desktop,omitempty"`
	HelperCommand string            `json:"-"`
	HelperArgs    []string          `json:"-"`
}
