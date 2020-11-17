namespace FortyTwo.Shared.Models
{
    public class Domino
    {
        public Domino()
        {

        }

        public Domino(int top, int bottom)
        {
            Top = top;
            Bottom = bottom;
        }

        public int Top { get; set; }
        public int Bottom { get; set; }
        public int Value => ((Top + Bottom) % 5 == 0) ? (Top + Bottom) % 5 : 0;
    }
}
