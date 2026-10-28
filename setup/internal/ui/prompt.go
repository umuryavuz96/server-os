package ui

import (
	"errors"

	"charm.land/huh/v2"
)

// Confirm asks a yes/no question. Ctrl+C returns ErrInterrupted.
func Confirm(title, description string, def bool) (bool, error) {
	v := def
	err := huh.NewForm(huh.NewGroup(
		huh.NewConfirm().Title(title).Description(description).Affirmative("Yes").Negative("No").Value(&v),
	)).WithTheme(Theme()).Run()
	return v, formErr(err)
}

// Choose asks the user to pick one of options (label → value), returning the value.
func Choose(title, description string, options ...huh.Option[string]) (string, error) {
	var v string
	err := huh.NewForm(huh.NewGroup(
		huh.NewSelect[string]().Title(title).Description(description).Options(options...).Value(&v),
	)).WithTheme(Theme()).Run()
	return v, formErr(err)
}

// RunForm runs a form with the wizard's theme.
func RunForm(groups ...*huh.Group) error {
	return formErr(huh.NewForm(groups...).WithTheme(Theme()).Run())
}

func formErr(err error) error {
	if errors.Is(err, huh.ErrUserAborted) {
		return ErrInterrupted
	}
	return err
}
